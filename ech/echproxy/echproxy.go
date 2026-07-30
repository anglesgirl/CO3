// Package echproxy is an on-device ECH (Encrypted Client Hello) front proxy for
// CO3 / AO3, designed to be compiled into the Android app with `gomobile bind`.
//
// It runs a small local HTTP reverse proxy on 127.0.0.1:<port>. Every request it
// receives is forwarded to https://<target> (archiveofourown.org) over a TLS 1.3
// handshake whose SNI is hidden with ECH, so the React Native HTTP client (ky)
// can point at the plain-HTTP loopback endpoint without doing any TLS itself.
//
// Two censorship problems are handled:
//   - SNI inspection  -> ECH (Config.EncryptedClientHelloConfigList, Go 1.24+)
//   - DNS poisoning   -> addresses are resolved over DoH and dialled directly,
//     bypassing the (poisoned) system resolver. IPv4 is preferred.
//
// gomobile-exported surface (basic types only, so it binds cleanly to Java):
//
//	Start(listen, target, echB64, doh string, insecure bool) error
//	Stop() error
//	LastStatus() string
package echproxy

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	dialTimeout = 20 * time.Second
	publicECHCacheTTL = 12 * time.Hour
)

// Last-resort Cloudflare public ECHConfigList for archiveofourown.org.
// Cloudflare rotates this value; retry_configs and the expiring public cache
// refresh it automatically when the edge returns a newer configuration.
const fallbackECH = "AEX+DQBBEgAgACCCqb/I3qllxRj0GsvaltwQOKEVxT3s7r9QsejF510DIgAEAAEAAQASY2xvdWRmbGFyZS1lY2guY29tAAA="

var (
	mu          sync.Mutex
	server      *http.Server
	lastStatus  = "not started"
	configInfo  string   // where the ECH config came from
	dnsInfo     string   // how the upstream IPs were resolved
	shakeInfo   string   // last TLS handshake result (ECHAccepted=…)
	upstreamIPs []string // DoH-resolved upstream addresses, IPv4 first
	customIPs   []string // user-supplied edge IPs, tried before everything else

	// Per-host state for secondary targets (translation API, mirrors, …) reached
	// through the same proxy via the X-Ech-Target header.
	hostsMu    sync.Mutex
	hostConfs  = map[string]*hostConf{}
	activeDoH  string
	activeInse bool
)

// hostConf caches what we learned about a secondary upstream: its DoH-resolved
// addresses and its ECH config (absent for servers that don't offer ECH).
type hostConf struct {
	ips       []string
	ech       []byte
	transport *http.Transport
}

func setStatus(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	mu.Lock()
	lastStatus = s
	mu.Unlock()
	log.Printf("echproxy: %s", s)
}

func setConfigInfo(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	mu.Lock()
	configInfo = s
	mu.Unlock()
	log.Printf("echproxy: config %s", s)
}

func setDNSInfo(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	mu.Lock()
	dnsInfo = s
	mu.Unlock()
	log.Printf("echproxy: dns %s", s)
}

func setShakeInfo(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	mu.Lock()
	shakeInfo = s
	mu.Unlock()
	log.Printf("echproxy: handshake %s", s)
}

// LastStatus returns a multi-line summary: ECH config source, DNS resolution,
// last handshake result (look for ECHAccepted=true), and the latest status line.
func LastStatus() string {
	mu.Lock()
	defer mu.Unlock()
	out := "config: " + orNone(configInfo) + "\n"
	out += "dns: " + orNone(dnsInfo) + "\n"
	if shakeInfo != "" {
		out += "handshake: " + shakeInfo + "\n"
	} else {
		out += "handshake: (none yet)\n"
	}
	out += "last: " + lastStatus
	return out
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

// Start binds a reverse proxy on `listen` that forwards to https://`target`
// over ECH, then serves in a background goroutine.
//
// ipList is an optional comma-separated list of upstream edge IPs to use
// instead of DNS (e.g. hand-picked fast Cloudflare IPs). Because Cloudflare is
// anycast, any edge IP serves the site — the SNI and the ECH config are
// unaffected, so a custom IP changes only the route, never the encryption.
func Start(listen, target, echB64, doh, ipList, cachePath string, insecure bool) error {
	return start(listen, target, echB64, doh, ipList, cachePath, insecure, true)
}

// StartStrict is for the standalone ECH test tool. Unlike Start, it never
// accepts a server-provided retry_configs list: a successful request therefore
// proves that the supplied ConfigList (including its public_name) was accepted
// by the server on the first handshake.
func StartStrict(listen, target, echB64, doh, ipList, cachePath string, insecure bool) error {
	return start(listen, target, echB64, doh, ipList, cachePath, insecure, false)
}

func start(listen, target, echB64, doh, ipList, cachePath string, insecure, allowRetry bool) error {
	mu.Lock()
	if server != nil {
		mu.Unlock()
		return errors.New("echproxy already running")
	}
	mu.Unlock()

	if target == "" {
		target = "archiveofourown.org"
	}

	// 1. Fetch the public ECHConfigList over DoH and share it through the
	// expiring cache. The cache contains no credentials, cookies, or keys.
	echList, src, err := loadECHConfig(target, echB64, doh, cachePath)
	if err != nil || len(echList) == 0 {
		return fmt.Errorf("could not obtain ECH config for %s: %v", target, err)
	}
	setConfigInfo("%d bytes for %s, source: %s", len(echList), target, src)

	// 2. User-supplied edge IPs take priority over any DNS result.
	custom := parseIPList(ipList)
	mu.Lock()
	customIPs = custom
	mu.Unlock()

	// 3. Resolve upstream IPs over DoH, bypassing the (possibly poisoned)
	//    system resolver. Failure is non-fatal: we fall back to system DNS.
	ips, derr := resolveViaDoH(target, doh)
	mu.Lock()
	upstreamIPs = ips
	mu.Unlock()

	switch {
	case len(custom) > 0 && len(ips) > 0:
		setDNSInfo("custom IP(s): %s | DoH also resolved: %s",
			strings.Join(custom, ", "), strings.Join(ips, ", "))
	case len(custom) > 0:
		setDNSInfo("custom IP(s): %s (DoH unused/failed: %v)", strings.Join(custom, ", "), derr)
	case derr != nil || len(ips) == 0:
		setDNSInfo("DoH resolve failed (%v) — falling back to system DNS (may be poisoned)", derr)
	default:
		setDNSInfo("DoH resolved %d addr(s): %s", len(ips), strings.Join(ips, ", "))
	}

	// Remember the settings so secondary hosts can be resolved the same way.
	hostsMu.Lock()
	activeDoH, activeInse = doh, insecure
	hostConfs = map[string]*hostConf{}
	hostsMu.Unlock()

	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		// Route each request to a transport built for its own host, so the proxy
		// can also front other services (e.g. a translation API) over DoH+ECH.
		Transport: &hostRouter{primary: target, primaryTransport: newECHTransport(target, echList, cachePath, insecure, allowRetry)},
		Jar:       jar,
		Timeout:   60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", listen, err)
	}

	srv := &http.Server{Handler: &proxyHandler{target: target, client: client}}
	mu.Lock()
	server = srv
	mu.Unlock()

	setStatus("reverse proxy listening on http://%s -> https://%s (via ECH)", listen, target)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			setStatus("server stopped: %v", err)
		}
		mu.Lock()
		server = nil
		mu.Unlock()
	}()
	return nil
}

// Stop shuts the proxy down. Safe to call when not running.
func Stop() error {
	mu.Lock()
	srv := server
	server = nil
	mu.Unlock()
	if srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	setStatus("stopping")
	return srv.Shutdown(ctx)
}

// --- reverse proxy handler ------------------------------------------------

type proxyHandler struct {
	target string
	client *http.Client
}

var hopByHop = map[string]bool{
	"Connection": true, "Proxy-Connection": true, "Keep-Alive": true,
	"Proxy-Authenticate": true, "Proxy-Authorization": true, "Te": true,
	"Trailer": true, "Transfer-Encoding": true, "Upgrade": true,
}

func (h *proxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// X-Ech-Target lets the app route other hosts (e.g. a translation API)
	// through the same DoH + ECH path instead of the poisoned system resolver.
	target := h.target
	if t := strings.TrimSpace(r.Header.Get("X-Ech-Target")); t != "" {
		if !isTargetHost(t) {
			http.Error(w, "echproxy: invalid target host", http.StatusBadRequest)
			return
		}
		target = strings.ToLower(t)
	}

	outURL := &url.URL{Scheme: "https", Host: target, Path: r.URL.Path, RawQuery: r.URL.RawQuery}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, outURL.String(), r.Body)
	if err != nil {
		http.Error(w, "echproxy: bad request: "+err.Error(), http.StatusBadGateway)
		return
	}
	for k, vv := range r.Header {
		if hopByHop[k] || k == "Host" || k == "X-Ech-Target" {
			continue
		}
		for _, v := range vv {
			req.Header.Add(k, v)
		}
	}
	req.Host = target
	req.Header.Del("Accept-Encoding")

	resp, err := h.client.Do(req)
	if err != nil {
		setStatus("upstream error %s %s: %v", r.Method, r.URL.Path, err)
		http.Error(w, "echproxy: upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if loc := resp.Header.Get("Location"); loc != "" {
		resp.Header.Set("Location", rewriteLocation(loc, target))
	}
	for k, vv := range resp.Header {
		if hopByHop[k] {
			continue
		}
		if resp.Uncompressed && (k == "Content-Encoding" || k == "Content-Length") {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// isTargetHost accepts DNS host names only. The header is intentionally not a
// general URL/authority escape hatch: ports, paths, userinfo, IP literals, and
// malformed names would bypass the per-host TLS/DNS routing assumptions.
func isTargetHost(value string) bool {
	if value == "" || len(value) > 253 || net.ParseIP(value) != nil || strings.ContainsAny(value, "/:@?#\\") {
		return false
	}
	for _, label := range strings.Split(strings.TrimSuffix(value, "."), ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if !(r == '-' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
				return false
			}
		}
	}
	return true
}

func rewriteLocation(loc, target string) string {
	u, err := url.Parse(loc)
	if err != nil {
		return loc
	}
	if u.Host == target || u.Host == "www."+target {
		u.Scheme, u.Host = "", ""
		return u.String()
	}
	return loc
}

// --- multi-host routing ---------------------------------------------------

// hostRouter sends each request through a transport built for its own hostname.
// The primary target keeps the transport built at Start(); any other host gets
// one created on demand (DoH-resolved addresses, ECH when the server offers it).
type hostRouter struct {
	primary          string
	primaryTransport *http.Transport
}

func (hr *hostRouter) RoundTrip(req *http.Request) (*http.Response, error) {
	host := req.URL.Hostname()
	if host == hr.primary || host == "" {
		return hr.primaryTransport.RoundTrip(req)
	}
	t, err := transportFor(host)
	if err != nil {
		return nil, err
	}
	return t.RoundTrip(req)
}

// transportFor lazily builds (and caches) a transport for a secondary host.
func transportFor(host string) (*http.Transport, error) {
	hostsMu.Lock()
	if hc, ok := hostConfs[host]; ok && hc.transport != nil {
		hostsMu.Unlock()
		return hc.transport, nil
	}
	doh, insecure := activeDoH, activeInse
	hostsMu.Unlock()

	hc := &hostConf{}
	if ips, err := resolveViaDoH(host, doh); err == nil {
		hc.ips = ips
	} else {
		log.Printf("echproxy: DoH resolve for %s failed: %v (falling back to system DNS)", host, err)
	}
	// ECH is optional here — most non-Cloudflare hosts don't publish it.
	if b, err := fetchECHViaDoH(host, doh); err == nil && len(b) > 0 {
		hc.ech = b
	}
	hc.transport = &http.Transport{
		DialTLSContext:        hostDialContext(host, hc, insecure),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   dialTimeout,
		ExpectContinueTimeout: 1 * time.Second,
	}

	hostsMu.Lock()
	hostConfs[host] = hc
	hostsMu.Unlock()
	log.Printf("echproxy: host %s ready (%d addr(s), ech=%v)", host, len(hc.ips), len(hc.ech) > 0)
	return hc.transport, nil
}

// hostDialContext dials a secondary host over its DoH-resolved addresses,
// enabling ECH only when that host actually publishes a config.
func hostDialContext(host string, hc *hostConf, insecure bool) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		_, port, err := net.SplitHostPort(addr)
		if err != nil || port == "" {
			port = "443"
		}
		cands := make([]string, 0, len(hc.ips)+1)
		for _, ip := range hc.ips {
			cands = append(cands, net.JoinHostPort(ip, port))
		}
		cands = append(cands, addr) // last resort: system DNS

		d := &net.Dialer{Timeout: dialTimeout}
		var raw net.Conn
		for _, c := range cands {
			raw, err = d.DialContext(ctx, "tcp", c)
			if err == nil {
				break
			}
		}
		if raw == nil {
			return nil, fmt.Errorf("dial %s failed: %w", host, err)
		}

		cfg := &tls.Config{
			ServerName:         host,
			MinVersion:         tls.VersionTLS12,
			NextProtos:         []string{"h2", "http/1.1"},
			InsecureSkipVerify: insecure,
		}
		if len(hc.ech) > 0 {
			cfg.EncryptedClientHelloConfigList = hc.ech
			cfg.MinVersion = tls.VersionTLS13
		}
		hctx, cancel := context.WithTimeout(ctx, dialTimeout)
		defer cancel()

		tc := tls.Client(raw, cfg)
		if err := tc.HandshakeContext(hctx); err != nil {
			var rej *tls.ECHRejectionError
			if errors.As(err, &rej) && len(rej.RetryConfigList) > 0 {
				raw.Close()
				raw2, derr := d.DialContext(ctx, "tcp", cands[0])
				if derr != nil {
					return nil, derr
				}
				cfg.EncryptedClientHelloConfigList = rej.RetryConfigList
				tc = tls.Client(raw2, cfg)
				if err2 := tc.HandshakeContext(hctx); err2 != nil {
					raw2.Close()
					return nil, fmt.Errorf("%s handshake failed: %w", host, err2)
				}
				return tc, nil
			}
			raw.Close()
			return nil, fmt.Errorf("%s handshake failed: %w", host, err)
		}
		return tc, nil
	}
}

// --- ECH transport --------------------------------------------------------

func newECHTransport(sni string, echList []byte, cachePath string, insecure, allowRetry bool) *http.Transport {
	return &http.Transport{
		DialTLSContext:        echDialContext(sni, echList, cachePath, insecure, allowRetry),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   dialTimeout,
		ExpectContinueTimeout: 1 * time.Second,
	}
}

// parseIPList splits a comma/space separated list into valid IP literals.
func parseIPList(s string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t' || r == ';'
	}) {
		f = strings.TrimSpace(f)
		if net.ParseIP(f) != nil {
			out = append(out, f)
		}
	}
	return out
}

// dialCandidates returns the addresses to try, in order:
// user-supplied IPs, then DoH-resolved (IPv4 first), then system DNS.
func dialCandidates(addr string) []string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		port = "443"
	}
	mu.Lock()
	custom := append([]string(nil), customIPs...)
	ips := append([]string(nil), upstreamIPs...)
	mu.Unlock()

	out := make([]string, 0, len(custom)+len(ips)+1)
	for _, ip := range custom {
		out = append(out, net.JoinHostPort(ip, port))
	}
	for _, ip := range ips {
		out = append(out, net.JoinHostPort(ip, port))
	}
	return append(out, addr) // last resort: system DNS
}

// echDialContext dials the upstream and performs a TLS 1.3 handshake with ECH.
func echDialContext(sni string, echList []byte, cachePath string, insecure, allowRetry bool) func(ctx context.Context, network, addr string) (net.Conn, error) {
	var logged sync.Once
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		d := &net.Dialer{Timeout: dialTimeout}
		candidates := dialCandidates(addr)
		var lastErr error

		// An edge can reset or reject an otherwise valid ECH connection. Try every
		// configured edge before failing, but never downgrade this protected path to
		// ordinary TLS (which would expose the real AO3 SNI).
		for _, dialed := range candidates {
			raw, err := d.DialContext(ctx, "tcp", dialed)
			if err != nil {
				lastErr = err
				log.Printf("echproxy: dial %s failed: %v", dialed, err)
				continue
			}

			cfg := &tls.Config{
				ServerName:                     sni,
				MinVersion:                     tls.VersionTLS13, // ECH requires TLS 1.3
				NextProtos:                     []string{"h2", "http/1.1"},
				EncryptedClientHelloConfigList: echList,
				InsecureSkipVerify:             insecure,
			}
			hctx, cancel := context.WithTimeout(ctx, dialTimeout)
			tc := tls.Client(raw, cfg)
			err = tc.HandshakeContext(hctx)
			cancel()

			// A server-provided retry config is the only ECH retry on this edge.
			// Persist it and also use it for later candidate IPs in this attempt.
			var rej *tls.ECHRejectionError
			if errors.As(err, &rej) && len(rej.RetryConfigList) > 0 && !allowRetry {
				raw.Close()
				setStatus("ECH rejected via %s; strict test refused server retry_configs (%d bytes)", dialed, len(rej.RetryConfigList))
				lastErr = fmt.Errorf("ECH config rejected (strict mode)")
				continue
			}
			if errors.As(err, &rej) && len(rej.RetryConfigList) > 0 {
				raw.Close()
				setStatus("ECH rejected via %s; retrying with server retry_configs (%d bytes)", dialed, len(rej.RetryConfigList))
				echList = rej.RetryConfigList
				storePublicECHCache(cachePath, sni, rej.RetryConfigList)
				raw, err = d.DialContext(ctx, "tcp", dialed)
				if err == nil {
					cfg.EncryptedClientHelloConfigList = echList
					hctx, retryCancel := context.WithTimeout(ctx, dialTimeout)
					tc = tls.Client(raw, cfg)
					err = tc.HandshakeContext(hctx)
					retryCancel()
				}
			}
			if err != nil {
				raw.Close()
				lastErr = err
				log.Printf("echproxy: ECH handshake via %s failed; trying next candidate: %v", dialed, err)
				continue
			}
			st := tc.ConnectionState()
			logged.Do(func() {
				setShakeInfo("ok via %s ECHAccepted=%v TLS=%s ALPN=%q",
					dialed, st.ECHAccepted, tlsVersionName(st.Version), st.NegotiatedProtocol)
			})
			return tc, nil
		}
		setShakeInfo("FAILED after %d ECH candidate(s): %v", len(candidates), lastErr)
		return nil, fmt.Errorf("ECH handshake failed after %d candidate(s): %w", len(candidates), lastErr)
	}
}

// --- DoH ------------------------------------------------------------------

type dohResp struct {
	Answer []struct {
		Type int    `json:"type"`
		Data string `json:"data"`
	} `json:"Answer"`
}

// dohQuery performs a DoH JSON query and returns the answer records.
func dohQuery(endpoint, name, qtype string) (*dohResp, error) {
	var lastErr error
	for _, base := range strings.Split(endpoint, ",") {
		base = strings.TrimSpace(base)
		if base == "" {
			continue
		}
		q := base
		if strings.Contains(q, "?") {
			q += "&"
		} else {
			q += "?"
		}
		q += "name=" + url.QueryEscape(name) + "&type=" + qtype
		req, err := http.NewRequest("GET", q, nil)
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("accept", "application/dns-json")
		resp, err := (&http.Client{Timeout: dialTimeout}).Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != 200 {
			lastErr = fmt.Errorf("DoH HTTP %d via %s", resp.StatusCode, base)
			resp.Body.Close()
			continue
		}
		var dr dohResp
		err = json.NewDecoder(resp.Body).Decode(&dr)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		return &dr, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no DoH endpoint configured")
	}
	return nil, lastErr
}

// resolveViaDoH returns the upstream IPs (IPv4 first) for host, using DoH so the
// poisoned system resolver is bypassed entirely.
func resolveViaDoH(host, endpoint string) ([]string, error) {
	if strings.TrimSpace(endpoint) == "" {
		return nil, errors.New("no DoH endpoint configured")
	}
	var v4, v6 []string
	var firstErr error

	if dr, err := dohQuery(endpoint, host, "A"); err == nil {
		for _, a := range dr.Answer {
			if a.Type == 1 && net.ParseIP(a.Data) != nil {
				v4 = append(v4, a.Data)
			}
		}
	} else {
		firstErr = err
	}

	if dr, err := dohQuery(endpoint, host, "AAAA"); err == nil {
		for _, a := range dr.Answer {
			if a.Type == 28 && net.ParseIP(a.Data) != nil {
				v6 = append(v6, a.Data)
			}
		}
	} else if firstErr == nil {
		firstErr = err
	}

	out := append(v4, v6...) // IPv4 first — broken/poisoned IPv6 is common
	if len(out) == 0 {
		if firstErr == nil {
			firstErr = errors.New("no A/AAAA records returned")
		}
		return nil, firstErr
	}
	return out, nil
}

// quotedRe extracts the quoted chunks of a TXT record. Long TXT values are
// split into multiple 255-byte strings, which DoH returns as "a" "b".
var quotedRe = regexp.MustCompile(`"([^"]*)"`)

// FetchTxt looks up the TXT records of `name` over DoH and returns them, one
// record per line, with quoting removed and split chunks re-joined.
//
// Used for remote configuration: the operator publishes a TXT record such as
//
//	v=co3ech1; doh=https://example.com/dns-query; ip=104.20.8.2,104.20.9.2
//
// so end users can pull working settings without knowing what DoH even is.
// The lookup itself goes over DoH, so a poisoned system resolver can't spoof it.
func FetchTxt(doh, name string) (string, error) {
	if strings.TrimSpace(doh) == "" {
		return "", errors.New("no DoH endpoint configured")
	}
	if strings.TrimSpace(name) == "" {
		return "", errors.New("no config domain given")
	}
	dr, err := dohQuery(doh, name, "TXT")
	if err != nil {
		return "", err
	}
	var lines []string
	for _, a := range dr.Answer {
		if a.Type != 16 { // TXT
			continue
		}
		s := a.Data
		if m := quotedRe.FindAllStringSubmatch(s, -1); len(m) > 0 {
			var b strings.Builder
			for _, g := range m {
				b.WriteString(g[1])
			}
			s = b.String()
		}
		s = strings.TrimSpace(s)
		if s != "" {
			lines = append(lines, s)
		}
	}
	if len(lines) == 0 {
		return "", errors.New("no TXT records found for " + name)
	}
	return strings.Join(lines, "\n"), nil
}

var echParamRe = regexp.MustCompile(`ech="?([A-Za-z0-9+/=]+)"?`)

// fetchECHViaDoH queries the HTTPS (type 65) record and pulls the ech= SvcParam.
func fetchECHViaDoH(host, endpoint string) ([]byte, error) {
	dr, err := dohQuery(endpoint, host, "HTTPS")
	if err != nil {
		return nil, err
	}
	for _, a := range dr.Answer {
		if a.Type != 65 { // HTTPS
			continue
		}
		if m := echParamRe.FindStringSubmatch(a.Data); m != nil {
			b, err := base64.StdEncoding.DecodeString(m[1])
			if err != nil {
				return nil, fmt.Errorf("ech param not base64: %w", err)
			}
			return b, nil
		}
	}
	return nil, errors.New("no ech= parameter in HTTPS record")
}

type publicECHCache struct {
	Host      string `json:"host"`
	ConfigB64 string `json:"config_b64"`
	ExpiresAt int64  `json:"expires_at"`
}

// The cache is deliberately limited to a public ECHConfigList and expiry.
// It is shared by all proxy starts in this app installation; it never stores
// HTTP data, cookies, credentials, private keys, or a bypass decision.
func loadPublicECHCache(path, host string) ([]byte, bool) {
	if strings.TrimSpace(path) == "" { return nil, false }
	data, err := os.ReadFile(path)
	if err != nil { return nil, false }
	var record publicECHCache
	if json.Unmarshal(data, &record) != nil || !strings.EqualFold(record.Host, host) || record.ExpiresAt <= time.Now().Unix() { return nil, false }
	b, err := base64.StdEncoding.DecodeString(record.ConfigB64)
	if err != nil || len(b) == 0 { return nil, false }
	return b, true
}

func storePublicECHCache(path, host string, config []byte) {
	if strings.TrimSpace(path) == "" || len(config) == 0 { return }
	record, err := json.Marshal(publicECHCache{Host: strings.ToLower(host), ConfigB64: base64.StdEncoding.EncodeToString(config), ExpiresAt: time.Now().Add(publicECHCacheTTL).Unix()})
	if err != nil { return }
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil { return }
	tmp, err := os.CreateTemp(filepath.Dir(path), ".echconfig-")
	if err != nil { return }
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(record); err != nil { tmp.Close(); return }
	if err = tmp.Chmod(0600); err != nil { tmp.Close(); return }
	if err = tmp.Close(); err != nil { return }
	_ = os.Rename(name, path)
}

func loadECHConfig(host, echB64, doh, cachePath string) ([]byte, string, error) {
	if strings.TrimSpace(echB64) != "" {
		b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(echB64))
		if err != nil { return nil, "", fmt.Errorf("ech base64: %w", err) }
		return b, "flag", nil
	}
	// Prefer a fresh public DNS record. This keeps config rotation fast while
	// making the cache a resilient shared base when DoH is temporarily blocked.
	if strings.TrimSpace(doh) != "" {
		if b, err := fetchECHViaDoH(host, doh); err == nil && len(b) > 0 {
			storePublicECHCache(cachePath, host, b)
			return b, "DoH (cached)", nil
		} else if cached, ok := loadPublicECHCache(cachePath, host); ok {
			return cached, fmt.Sprintf("public cache (DoH failed: %v)", err), nil
		} else if err != nil {
			b2, e2 := base64.StdEncoding.DecodeString(fallbackECH)
			if e2 != nil { return nil, "", e2 }
			return b2, fmt.Sprintf("baked-in-fallback (DoH failed: %v)", err), nil
		}
	}
	if cached, ok := loadPublicECHCache(cachePath, host); ok { return cached, "public cache", nil }
	b, err := base64.StdEncoding.DecodeString(fallbackECH)
	if err != nil { return nil, "", err }
	return b, "baked-in-fallback", nil
}

func tlsVersionName(v uint16) string {
	switch v {
	case tls.VersionTLS13:
		return "1.3"
	case tls.VersionTLS12:
		return "1.2"
	default:
		return fmt.Sprintf("0x%04x", v)
	}
}
