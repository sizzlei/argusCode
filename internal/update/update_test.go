package update

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.9.1", "0.9.0", true},
		{"v0.10.0", "0.9.9", true},
		{"1.0.0", "0.99.99", true},
		{"0.9.0", "0.9.0", false},
		{"0.9.0", "0.9.1", false},
		{"0.9.2-beta", "0.9.1", true},
		{"0.9", "0.9.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestAssetName(t *testing.T) {
	if AssetName("darwin", "arm64") != "ArgusCode-macos-universal.zip" ||
		AssetName("windows", "amd64") != "ArgusCode-windows-amd64.zip" ||
		AssetName("linux", "amd64") != "" {
		t.Fatal("unexpected asset names")
	}
}

// fakeGitHub serves the REST API (optionally rate limited), the release feed
// and the download URLs.
func fakeGitHub(t *testing.T, limited bool, payload []byte) *httptest.Server {
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dl := "/" + Repo + "/releases/download/v0.9.2/"
		switch {
		case strings.HasPrefix(r.URL.Path, "/repos/") && limited:
			w.WriteHeader(http.StatusForbidden)
		case r.URL.Path == "/repos/"+Repo+"/releases/latest", r.URL.Path == "/repos/"+Repo+"/releases/tags/v0.9.2":
			json.NewEncoder(w).Encode(map[string]any{
				"tag_name": "v0.9.2", "name": "v0.9.2 — test", "body": "## 수정\n- 무엇", "html_url": "https://example/rel",
				"assets": []map[string]any{
					{"name": "ArgusCode-windows-amd64.zip", "size": len(payload), "browser_download_url": srv.URL + dl + "ArgusCode-windows-amd64.zip", "digest": "sha256:" + digest},
				},
			})
		case r.URL.Path == "/"+Repo+"/releases.atom":
			w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>v0.9.2</title><updated>2026-10-31T00:00:00Z</updated>
<link rel="alternate" type="text/html" href="https://github.com/` + Repo + `/releases/tag/v0.9.2"/>
<content type="html">&lt;h2&gt;수정&lt;/h2&gt;</content></entry>
<entry><title>v0.9.1</title><link rel="alternate" type="text/html" href="https://github.com/` + Repo + `/releases/tag/v0.9.1"/><content type="html">old</content></entry>
</feed>`))
		case strings.HasPrefix(r.URL.Path, dl) && strings.HasSuffix(r.URL.Path, ".sha256"):
			w.Write([]byte(digest + "  file.zip\n"))
		case strings.HasPrefix(r.URL.Path, dl+"bad"):
			w.Write([]byte("tampered"))
		case strings.HasPrefix(r.URL.Path, dl):
			w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	APIBase, WebBase = srv.URL, srv.URL
	t.Cleanup(func() {
		srv.Close()
		APIBase, WebBase = "https://api.github.com", "https://github.com"
	})
	return srv
}

func TestLatestAndDownload(t *testing.T) {
	payload := []byte("zip-bytes")
	srv := fakeGitHub(t, false, payload)
	r, err := Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != "0.9.2" || r.Notes == "" {
		t.Fatalf("release = %+v", r)
	}
	var gr ghRelease
	gr.TagName = "v1.0.0"
	gr.Assets = append(gr.Assets, struct {
		Name               string `json:"name"`
		Size               int64  `json:"size"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Digest             string `json:"digest"`
	}{Name: "ArgusCode-windows-amd64.zip", BrowserDownloadURL: "u"})
	if toRelease(&gr, "windows", "amd64").AssetURL != "u" || toRelease(&gr, "darwin", "arm64").AssetURL != "" {
		t.Fatal("asset selection")
	}

	sum := sha256.Sum256(payload)
	dir := t.TempDir()
	base := srv.URL + "/" + Repo + "/releases/download/v0.9.2/"
	r.AssetName, r.AssetURL, r.Digest = "a.zip", base+"a.zip", "sha256:"+hex.EncodeToString(sum[:])
	var seen int64
	p, err := Download(context.Background(), r, dir, func(d, _ int64) { seen = d })
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != string(payload) || seen != int64(len(payload)) {
		t.Fatal("download content / progress")
	}
	r.AssetURL = base + "bad.zip"
	if _, err := Download(context.Background(), r, dir, nil); err == nil {
		t.Fatal("tampered download accepted")
	}
	r.AssetURL = "https://evil.example/ArgusCode.zip"
	if _, err := Download(context.Background(), r, dir, nil); err == nil {
		t.Fatal("foreign URL accepted")
	}
}

func TestFeedFallbackWhenRateLimited(t *testing.T) {
	fakeGitHub(t, true, []byte("zip"))
	r, err := Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if r.Tag != "v0.9.2" || r.NotesHTML != "<h2>수정</h2>" {
		t.Fatalf("latest from feed = %+v", r)
	}
	old, err := ByTag(context.Background(), "v0.9.1")
	if err != nil || old.NotesHTML != "old" {
		t.Fatalf("by tag from feed = %+v, %v", old, err)
	}
	if _, err := ByTag(context.Background(), "v9.9.9"); err == nil {
		t.Fatal("missing tag found")
	}
	// Asset URL and checksum for this host (only on platforms with releases).
	if Supported() {
		if !strings.HasSuffix(r.AssetURL, "/releases/download/v0.9.2/"+r.AssetName) || !strings.HasPrefix(r.Digest, "sha256:") {
			t.Fatalf("asset from feed = %+v", r)
		}
	}
}

func TestExtractFile(t *testing.T) {
	dir := t.TempDir()
	zp := filepath.Join(dir, "a.zip")
	f, _ := os.Create(zp)
	zw := zip.NewWriter(f)
	w, _ := zw.Create("build/ArgusCode.exe")
	w.Write([]byte("MZ"))
	zw.Close()
	f.Close()
	dst := filepath.Join(dir, "out.exe")
	if err := extractFile(zp, "ArgusCode.exe", dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "MZ" {
		t.Fatal("content")
	}
	if err := extractFile(zp, "missing.exe", dst); err == nil {
		t.Fatal("missing member accepted")
	}
}
