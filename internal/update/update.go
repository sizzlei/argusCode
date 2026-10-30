// Package update checks GitHub Releases for a newer ArgusCode, downloads the
// archive for this platform and swaps it in place of the running app.
//
//   - macOS: ArgusCode.app inside the zip replaces the running bundle (the old
//     one is moved aside first, so a failure can be rolled back).
//   - Windows: the running ArgusCode.exe is renamed to ArgusCode.exe.old (a
//     running exe can be renamed but not overwritten) and the new exe takes
//     its name. The .old file is removed on the next start.
//
// Only release assets of the fixed repository are downloaded, over HTTPS, and
// their SHA-256 is checked when GitHub publishes a digest.
package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Repo is the GitHub repository releases are taken from.
const Repo = "sizzlei/argusCode"

// APIBase and WebBase can be replaced in tests.
var (
	APIBase = "https://api.github.com"
	WebBase = "https://github.com"
)

// errRateLimited: the REST API refuses unauthenticated calls after 60 an
// hour per IP — common behind a company NAT. The release feed and download
// URLs on github.com are not limited that way, so they are the fallback.
var errRateLimited = errors.New("GitHub 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요")

var client = &http.Client{Timeout: 30 * time.Second}

// Release is the part of a GitHub release the app needs.
type Release struct {
	Version   string `json:"version"` // "0.9.2"
	Tag       string `json:"tag"`     // "v0.9.2"
	Name      string `json:"name"`
	Notes     string `json:"notes"`     // Markdown body (REST API)
	NotesHTML string `json:"notesHtml"` // HTML body (release feed fallback)
	URL       string `json:"url"`       // release page
	Published string `json:"published"`
	AssetName string `json:"assetName"`
	AssetURL  string `json:"assetUrl"`
	AssetSize int64  `json:"assetSize"`
	Digest    string `json:"-"` // "sha256:…" when GitHub provides it
}

type ghRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	Body        string `json:"body"`
	HTMLURL     string `json:"html_url"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
	PublishedAt string `json:"published_at"`
	Assets      []struct {
		Name               string `json:"name"`
		Size               int64  `json:"size"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Digest             string `json:"digest"`
	} `json:"assets"`
}

// AssetName is the release archive for an OS / architecture ("" = none).
func AssetName(goos, goarch string) string {
	switch goos {
	case "darwin":
		return "ArgusCode-macos-universal.zip"
	case "windows":
		if goarch == "amd64" || goarch == "arm64" { // arm64 runs the x64 build
			return "ArgusCode-windows-amd64.zip"
		}
	}
	return ""
}

// Supported reports whether this platform can update itself.
func Supported() bool { return AssetName(runtime.GOOS, runtime.GOARCH) != "" }

// Latest returns the newest published release.
func Latest(ctx context.Context) (*Release, error) {
	r, err := fetch(ctx, "/repos/"+Repo+"/releases/latest")
	if errors.Is(err, errRateLimited) {
		return fromFeed(ctx, "")
	}
	return r, err
}

// ByTag returns the release with the given tag ("v0.9.2").
func ByTag(ctx context.Context, tag string) (*Release, error) {
	r, err := fetch(ctx, "/repos/"+Repo+"/releases/tags/"+tag)
	if errors.Is(err, errRateLimited) {
		return fromFeed(ctx, tag)
	}
	return r, err
}

func fetch(ctx context.Context, path string) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, APIBase+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ArgusCode-updater")
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("업데이트 서버에 연결할 수 없습니다: %w", err)
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusNotFound:
		return nil, errors.New("릴리스를 찾을 수 없습니다")
	case res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusTooManyRequests:
		return nil, errRateLimited
	case res.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("업데이트 확인 실패 (HTTP %d)", res.StatusCode)
	}
	var gr ghRelease
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&gr); err != nil {
		return nil, fmt.Errorf("릴리스 정보를 읽을 수 없습니다: %w", err)
	}
	return toRelease(&gr, runtime.GOOS, runtime.GOARCH), nil
}

func toRelease(gr *ghRelease, goos, goarch string) *Release {
	r := &Release{
		Version:   strings.TrimPrefix(gr.TagName, "v"),
		Tag:       gr.TagName,
		Name:      gr.Name,
		Notes:     gr.Body,
		URL:       gr.HTMLURL,
		Published: gr.PublishedAt,
	}
	want := AssetName(goos, goarch)
	for _, a := range gr.Assets {
		if a.Name == want {
			r.AssetName, r.AssetURL, r.AssetSize, r.Digest = a.Name, a.BrowserDownloadURL, a.Size, a.Digest
		}
	}
	return r
}

// Newer reports whether version a is newer than b ("0.10.0" > "0.9.1").
// Pre-release suffixes ("-beta") are ignored.
func Newer(a, b string) bool {
	pa, pb := parse(a), parse(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parse(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+ "); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, p := range strings.SplitN(v, ".", 3) {
		out[i], _ = strconv.Atoi(p)
	}
	return out
}

// Download saves the release archive into dir and verifies its digest.
// progress (may be nil) receives the bytes written so far.
func Download(ctx context.Context, r *Release, dir string, progress func(done, total int64)) (string, error) {
	if r.AssetURL == "" {
		return "", errors.New("이 운영체제용 파일이 릴리스에 없습니다")
	}
	if !strings.HasPrefix(r.AssetURL, WebBase+"/"+Repo+"/releases/download/") {
		return "", fmt.Errorf("예상하지 못한 다운로드 주소입니다: %s", r.AssetURL)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.AssetURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "ArgusCode-updater")
	dl := &http.Client{Timeout: 10 * time.Minute}
	res, err := dl.Do(req)
	if err != nil {
		return "", fmt.Errorf("다운로드 실패: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("다운로드 실패 (HTTP %d)", res.StatusCode)
	}
	total := res.ContentLength
	if total <= 0 {
		total = r.AssetSize
	}
	path := filepath.Join(dir, r.AssetName)
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	var done int64
	buf := make([]byte, 64<<10)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				f.Close()
				return "", err
			}
			h.Write(buf[:n])
			done += int64(n)
			if progress != nil {
				progress(done, total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return "", fmt.Errorf("다운로드 중단: %w", rerr)
		}
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	if want, ok := strings.CutPrefix(r.Digest, "sha256:"); ok {
		if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, want) {
			os.Remove(path)
			return "", errors.New("내려받은 파일의 체크섬이 맞지 않습니다")
		}
	}
	return path, nil
}
