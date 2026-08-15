package echproxy

// CF IP 优选扫描（2026-08-15 参考白嫖 cfip 工具实现，与 ech-proxy-go
// internal/cloudflare/preferred.go 同源）：
//   1. 拉取白嫖优选 IP 列表（www.baipiao.eu.org/cloudflare/ips-v4），
//      社区维护的活跃 CF 边缘，命中率远高于全段随机采样；失败回退内置
//      AS13335 CIDR 随机采样。
//   2. 并发测速：TCP connect + TLS 握手（SNI=cloudflare.com 证书验证），
//      握手成功 = 边缘可达且能服务 CF 内容；按总耗时排序。
//   3. 返回最快的前 n 个 —— 代理启动后前置到 customIPs，移动宽带下避免
//      串行试不可达 IP 白等（2026-08-14 CO3 实测每次请求卡 40s+）。

import (
	"context"
	"crypto/tls"
	"io"
	"math/rand"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	baipiaoIPv4URL = "https://www.baipiao.eu.org/cloudflare/ips-v4"
	baipiaoIPv6URL = "https://www.baipiao.eu.org/cloudflare/ips-v6"
	probeHost      = "cloudflare.com" // 测速探活目标（CF 自有域名，任意边缘都服务）
)

// fetchPreferredList 拉取白嫖优选 IP 列表，过滤 AS13335。失败返回 nil。
func fetchPreferredList(timeout time.Duration) []string {
	client := &http.Client{Timeout: timeout}
	var out []string
	for _, u := range []string{baipiaoIPv4URL, baipiaoIPv6URL} {
		resp, err := client.Get(u)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		resp.Body.Close()
		for _, line := range strings.Split(string(body), "\n") {
			ip := strings.TrimSpace(line)
			if ip == "" || !isCloudflareAS13335(ip) {
				continue
			}
			out = append(out, ip)
		}
		if len(out) > 0 {
			break
		}
	}
	return out
}

// scanPreferredCFIPs 一键优选：拉列表 → 测速 → 最快 n 个。
// 列表拉取失败用内置 CIDR 随机采样兜底；budget 为总时间预算。
func scanPreferredCFIPs(n int, budget time.Duration) []string {
	if n <= 0 {
		n = 5
	}
	deadline := time.Now().Add(budget)
	var ips []string
	if dl := deadline.Sub(time.Now()); dl > time.Second {
		ips = fetchPreferredList(dl)
	}
	if len(ips) == 0 {
		rng := rand.New(rand.NewSource(time.Now().UnixNano()))
		ips = randomSampleCFIPs(256, rng)
	}
	if len(ips) == 0 {
		return nil
	}
	// 候选数限制：预算 8s / 单 IP 最多 3s / 16 并发 ≈ 最多 ~40 个能测完。
	// baipiao 列表可能几百个，全测会远超预算（2026-08-15 实测 256 个
	// 随机采样跑满 48s，后台卡死还撞掉连接池）。取前 40 个足够挑出快的。
	if len(ips) > 40 {
		ips = ips[:40]
	}
	remain := deadline.Sub(time.Now())
	if remain <= 0 {
		return nil
	}
	timeout := 3 * time.Second
	if remain < timeout {
		timeout = remain
	}
	return speedScanCFIPs(ips, n, 16, timeout)
}

// speedScanCFIPs 并发测速候选 IP，按总耗时升序返回最快的前 n 个。
func speedScanCFIPs(ips []string, n, concurrency int, timeout time.Duration) []string {
	if len(ips) == 0 {
		return nil
	}
	if concurrency <= 0 {
		concurrency = 64
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	type result struct {
		ip string
		ms int64
	}
	results := make(chan result, len(ips))
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)
	for _, ip := range ips {
		ip = strings.TrimSpace(ip)
		if ip == "" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(ip string) {
			defer wg.Done()
			defer func() { <-sem }()
			if ms, ok := probeLatency(ip, timeout); ok {
				results <- result{ip, ms}
			}
		}(ip)
	}
	wg.Wait()
	close(results)

	list := make([]result, 0, len(ips))
	for r := range results {
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ms < list[j].ms })
	if len(list) > n {
		list = list[:n]
	}
	out := make([]string, len(list))
	for i, r := range list {
		out[i] = r.ip
	}
	return out
}

// probeLatency 单 IP 测速：TCP connect + TLS 握手（SNI=cloudflare.com）。
func probeLatency(ip string, timeout time.Duration) (int64, bool) {
	start := time.Now()
	d := &net.Dialer{Timeout: timeout}
	conn, err := d.Dial("tcp", net.JoinHostPort(ip, "443"))
	if err != nil {
		return 0, false
	}
	defer conn.Close()
	remain := timeout - time.Since(start)
	if remain <= 0 {
		return 0, false
	}
	hctx, cancel := context.WithTimeout(context.Background(), remain)
	defer cancel()
	tc := tls.Client(conn, &tls.Config{
		ServerName: probeHost,
		MinVersion: tls.VersionTLS12,
	})
	if err := tc.HandshakeContext(hctx); err != nil {
		return 0, false
	}
	tc.Close()
	return time.Since(start).Milliseconds(), true
}

// randomSampleCFIPs 从内置 AS13335 CIDR 随机采样 n 个候选（列表拉取失败兜底）。
func randomSampleCFIPs(n int, rng *rand.Rand) []string {
	var out []string
	seen := map[string]bool{}
	for len(out) < n {
		if len(cloudflareAS13335CIDRs) == 0 {
			break
		}
		_, network, err := net.ParseCIDR(cloudflareAS13335CIDRs[rng.Intn(len(cloudflareAS13335CIDRs))])
		if err != nil || network == nil {
			continue
		}
		ip := randomIPInNet(network, rng)
		if ip != nil && !seen[ip.String()] {
			seen[ip.String()] = true
			out = append(out, ip.String())
		}
	}
	return out
}

// randomIPInNet 在网段内随机生成一个 IP（只随机低 16 位 host 位）。
func randomIPInNet(network *net.IPNet, rng *rand.Rand) net.IP {
	ip := network.IP.To4()
	bits := 32
	if ip == nil {
		ip = network.IP.To16()
		bits = 128
	}
	if ip == nil {
		return nil
	}
	ones, _ := network.Mask.Size()
	out := make(net.IP, len(ip))
	copy(out, ip)
	hostBits := bits - ones
	if hostBits > 16 {
		hostBits = 16
	}
	for i := 0; i < hostBits; i++ {
		byteIdx := (ones + i) / 8
		bitIdx := 7 - (ones+i)%8
		if rng.Intn(2) == 1 {
			out[byteIdx] |= 1 << bitIdx
		}
	}
	return out
}
