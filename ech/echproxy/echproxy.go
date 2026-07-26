// Package echproxy is an on-device ECH (Encrypted Client Hello) front proxy for
// CO3 / AO3, designed to be compiled into the Android app with `gomobile bind`.
//
// It runs a small local HTTP reverse proxy on 127.0.0.1:<port>. Every request it
// receives is forwarded to https://<target> (archiveofourown.org) over a TLS 1.3
// handshake whose SNI is hidden with ECH, so the React Native HTTP client (ky)
// can point at the plain-HTTP loopback endpoint without doing any TLS itself.
//
// Requires Go 1.24+ (crypto/tls client-side ECH:
// Config.EncryptedClientHelloConfigList and ConnectionState.ECHAccepted).
//
// gomobile-exported surface (kept to basic types so it binds cleanly to Java):
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
	"regexp"
	"strings"
	"sync"
	"time"
)

const dialTimeout = 20 * time.Second

// Last-resort baked-in ECHConfigList for archiveofourown.org (public_name
// cloudflare-ech.com). Cloudflare ROTATES these, so it WILL go stale — it only
// exists so the proxy still starts when DoH is blocked (common behind the GFW).
// The retry_configs self-heal path below fixes a stale value automatically as
// long as the ECH handshake itself is allowed through.
const fallbackECH = "AEX+DQBBEgAgACCCqb/I3qllxRj0GsvaltwQOKEVxT3s7r9QsejF510DIgAEAAEAAQASY2xvdWRmbGFyZS1lY2guY29tAAA="

var (
	mu         sync.Mutex
	server     *http.Server
	lastStatus = "not started"
	configInfo string // where the ECH config came from (DoH / fallback / flag)
	shakeInfo  string // last TLS handshake result (ECHAccepted=…)
)

// setStatus records a human-readable status string for LastStatus().
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
	log.Printf("echproxy: %s", s)
}

func setShakeInfo(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	mu.Lock()
	shakeInfo = s
	mu.Unlock()
	log.Printf("echproxy: %s", s)
}

// LastStatus returns a multi-line summary: ECH config source, last handshake
// result (look for ECHAccepted=true), and the most recent status/error line.
func LastStatus() string {
	mu.Lock()
	defer mu.Unlock()
	out := ""
	if configInfo != "" {
		out += "config: " + configInfo + "\n"
	}
	if shakeInfo != "" {
		out += "handshake: " + shakeInfo + "\n"
	} else {
		out += "handshake: (none yet)\n"
	}
	out += "last: " + lastStatus
	return out
}

// Start binds a reverse proxy on `listen` (e.g. "127.0.0.1:8080") that forwards
// to https://`target` (e.g. "archiveofourown.org") over ECH, then serves in a
// background goroutine. It returns once the listener is bound (nil), or an error
// if the bind fails or an ECH config cannot be obtained.
//
//   - echB64:  optional base64 ECHConfigList; overrides DoH/fallback when set.
//   - doh:     DoH JSON endpoint (e.g. "https://dns.google/resolve"); may be "".
//   - insecure: skip upstream cert verification (debug only).
func Start(listen, target, echB64, doh string, insecure bool) error {
	mu.Lock()
	if server != nil {
		mu.Unlock()
		return errors.New("echproxy already running")
	}
	mu.Unlock()

	if target == "" {
		target = "archiveofourown.org"
	}

	echList, src, err := loadECHConfig(target, echB64, doh)
	if err != nil || len(echList) == 0 {
		return fmt.Errorf("could not obtain ECH config for %s: %v", target, err)
	}
	setConfigInfo("%d bytes for %s, source: %s", len(echList), target, src)

	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Transport: newECHTransport(target, echList, insecure),
		Jar:       jar,
		Timeout:   60 * time.Second,
		// Don't follow redirects here — hand them back so ky follows them and
		// re-enters the proxy via the URL rewrite (keeps one cookie jar).
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	handler := &proxyHandler{target: target, client: client}

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", listen, err)
	}

	srv := &http.Server{Handler: handler}
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

// hopByHop headers must not be forwarded (RFC 7230 §6.1).
var hopByHop = map[string]bool{
	"Connection":          true,
	"Proxy-Connection":    true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

func (h *proxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	outURL := &url.URL{
		Scheme:   "https",
		Host:     h.target,
		Path:     r.URL.Path,
		RawQuery: r.URL.RawQuery,
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, outURL.String(), r.Body)
	if err != nil {
		http.Error(w, "echproxy: bad request: "+err.Error(), http.StatusBadGateway)
		return
	}
	// Copy request headers except hop-by-hop and Host.
	for k, vv := range r.Header {
		if hopByHop[k] || k == "Host" {
			continue
		}
		for _, v := range vv {
			req.Header.Add(k, v)
		}
	}
	req.Host = h.target
	// Let Go negotiate/decompress; avoid a stale Accept-Encoding from the app.
	req.Header.Del("Accept-Encoding")

	resp, err := h.client.Do(req)
	if err != nil {
		setStatus("upstream error %s %s: %v", r.Method, r.URL.Path, err)
		http.Error(w, "echproxy: upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Rewrite absolute redirect targets so ky re-enters the proxy.
	if loc := resp.Header.Get("Location"); loc != "" {
		resp.Header.Set("Location", rewriteLocation(loc, h.target))
	}

	for k, vv := range resp.Header {
		if hopByHop[k] {
			continue
		}
		// Body has been transparently decompressed by the Go transport.
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

// rewriteLocation turns an absolute https://<target>/… redirect into a relative
// path so ky (pointed at the loopback proxy) follows it back through us.
func rewriteLocation(loc, target string) string {
	u, err := url.Parse(loc)
	if err != nil {
		return loc
	}
	if u.Host == target || u.Host == "www."+target {
		u.Scheme = ""
		u.Host = ""
		return u.String()
	}
	return loc
}

// --- ECH transport --------------------------------------------------------

func newECHTransport(sni string, echList []byte, insecure bool) *http.Transport {
	return &http.Transport{
		DialTLSContext:        echDialContext(sni, echList, insecure),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   dialTimeout,
		ExpectContinueTimeout: 1 * time.Second,
	}
}

// echDialContext dials host:443 and performs a TLS 1.3 handshake with ECH.
func echDialContext(sni string, echList []byte, insecure bool) func(ctx context.Context, network, addr string) (net.Conn, error) {
	var logged sync.Once
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		d := &net.Dialer{Timeout: dialTimeout}
		raw, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
		cfg := &tls.Config{
			ServerName:                     sni,
			MinVersion:                     tls.VersionTLS13, // ECH requires TLS 1.3
			NextProtos:                     []string{"h2", "http/1.1"},
			EncryptedClientHelloConfigList: echList,
			InsecureSkipVerify:             insecure,
		}
		hctx, cancel := context.WithTimeout(ctx, dialTimeout)
		defer cancel()

		tc := tls.Client(raw, cfg)
		err = tc.HandshakeContext(hctx)

		// If the server rejected our (stale/GREASE) ECH config, it returns a fresh
		// ECHConfigList in retry_configs. Redial once with it — this self-heals
		// against config rotation and a blocked DoH lookup.
		var rej *tls.ECHRejectionError
		if errors.As(err, &rej) && len(rej.RetryConfigList) > 0 {
			raw.Close()
			setStatus("ECH rejected; retrying with server retry_configs (%d bytes)", len(rej.RetryConfigList))
			raw2, derr := d.DialContext(ctx, "tcp", addr)
			if derr != nil {
				return nil, derr
			}
			cfg.EncryptedClientHelloConfigList = rej.RetryConfigList
			tc = tls.Client(raw2, cfg)
			raw = raw2
			err = tc.HandshakeContext(hctx)
		}
		if err != nil {
			raw.Close()
			if errors.As(err, &rej) {
				setShakeInfo("FAILED: server rejected ECH, %d bytes retry_configs "+
					"(if 0, endpoint likely isn't a real ECH server)", len(rej.RetryConfigList))
				return nil, fmt.Errorf("ECH handshake failed: server rejected ECH, %d bytes retry_configs",
					len(rej.RetryConfigList))
			}
			setShakeInfo("FAILED: %v", err)
			return nil, fmt.Errorf("ECH handshake failed: %w", err)
		}
		st := tc.ConnectionState()
		logged.Do(func() {
			setShakeInfo("ok ECHAccepted=%v TLS=%s ALPN=%q",
				st.ECHAccepted, tlsVersionName(st.Version), st.NegotiatedProtocol)
		})
		return tc, nil
	}
}

// --- ECH config resolution ------------------------------------------------

func loadECHConfig(host, echB64, doh string) ([]byte, string, error) {
	if strings.TrimSpace(echB64) != "" {
		b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(echB64))
		if err != nil {
			return nil, "", fmt.Errorf("ech base64: %w", err)
		}
		return b, "flag", nil
	}
	if doh != "" {
		if b, err := fetchECHViaDoH(host, doh); err == nil && len(b) > 0 {
			return b, "DoH:" + doh, nil
		} else if err != nil {
			log.Printf("echproxy: DoH lookup failed (%v); using baked-in fallback", err)
		}
	}
	b, err := base64.StdEncoding.DecodeString(fallbackECH)
	if err != nil {
		return nil, "", err
	}
	return b, "baked-in-fallback", nil
}

type dohResp struct {
	Answer []struct {
		Type int    `json:"type"`
		Data string `json:"data"`
	} `json:"Answer"`
}

var echParamRe = regexp.MustCompile(`ech="?([A-Za-z0-9+/=]+)"?`)

// fetchECHViaDoH queries the HTTPS (type 65) record and pulls the ech= SvcParam.
func fetchECHViaDoH(host, endpoint string) ([]byte, error) {
	q := endpoint + "?name=" + url.QueryEscape(host) + "&type=HTTPS"
	req, _ := http.NewRequest("GET", q, nil)
	req.Header.Set("accept", "application/dns-json")
	resp, err := (&http.Client{Timeout: dialTimeout}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("DoH HTTP %d", resp.StatusCode)
	}
	var dr dohResp
	if err := json.NewDecoder(resp.Body).Decode(&dr); err != nil {
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
	return nil, fmt.Errorf("no ech= parameter in HTTPS record")
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
