package echproxy

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPublicECHCacheRoundTripAndExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache", "ech.json")
	config := []byte{1, 2, 3, 4}
	storePublicECHCache(path, "archiveofourown.org", config)
	got, ok := loadPublicECHCache(path, "ARCHIVEOFOUROWN.ORG")
	if !ok || string(got) != string(config) {
		t.Fatalf("cache = %x, %v; want %x, true", got, ok, config)
	}
	data, err := os.ReadFile(path)
	if err != nil { t.Fatal(err) }
	if string(data) == string(config) { t.Fatal("cache must encode the public config rather than write raw bytes") }
	if err := os.WriteFile(path, []byte(`{"host":"archiveofourown.org","config_b64":"`+base64.StdEncoding.EncodeToString(config)+`","expires_at":`+"1"+`}`), 0600); err != nil { t.Fatal(err) }
	if _, ok := loadPublicECHCache(path, "archiveofourown.org"); ok { t.Fatal("expired cache was accepted") }
}

func TestPublicECHCacheRejectsWrongHostAndMalformedData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ech.json")
	storePublicECHCache(path, "archiveofourown.org", []byte{1})
	if _, ok := loadPublicECHCache(path, "example.org"); ok { t.Fatal("cache accepted another host") }
	if err := os.WriteFile(path, []byte("not json"), 0600); err != nil { t.Fatal(err) }
	if _, ok := loadPublicECHCache(path, "archiveofourown.org"); ok { t.Fatal("malformed cache was accepted") }
}

func TestTargetHostValidation(t *testing.T) {
	for _, host := range []string{"archiveofourown.org", "www.archiveofourown.org", "images.weserv.nl", "api-1.example.org"} {
		if !isTargetHost(host) { t.Errorf("valid host rejected: %q", host) }
	}
	for _, host := range []string{"", "archiveofourown.org:443", "https://archiveofourown.org", "127.0.0.1", "[::1]", "-bad.example", "bad_.example", "user@host"} {
		if isTargetHost(host) { t.Errorf("invalid host accepted: %q", host) }
	}
}

func TestPublicECHCacheTTLIsBounded(t *testing.T) {
	if publicECHCacheTTL <= 0 || publicECHCacheTTL > 24*time.Hour { t.Fatalf("unexpected cache ttl: %s", publicECHCacheTTL) }
}
