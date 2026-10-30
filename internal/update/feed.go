package update

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
)

type atomFeed struct {
	Entries []struct {
		Title   string `xml:"title"`
		Updated string `xml:"updated"`
		Link    struct {
			Href string `xml:"href,attr"`
		} `xml:"link"`
		Content string `xml:"content"`
	} `xml:"entry"`
}

// fromFeed reads the release from github.com/<repo>/releases.atom (newest
// first; tag "" = latest). Asset URLs follow the fixed download pattern and
// the checksum comes from the "<asset>.sha256" file CI publishes next to it.
func fromFeed(ctx context.Context, tag string) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, WebBase+"/"+Repo+"/releases.atom", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ArgusCode-updater")
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("업데이트 서버에 연결할 수 없습니다: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("업데이트 확인 실패 (HTTP %d)", res.StatusCode)
	}
	var feed atomFeed
	if err := xml.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&feed); err != nil {
		return nil, fmt.Errorf("릴리스 정보를 읽을 수 없습니다: %w", err)
	}
	for _, e := range feed.Entries {
		href := e.Link.Href
		i := strings.LastIndex(href, "/releases/tag/")
		if i < 0 {
			continue
		}
		t := href[i+len("/releases/tag/"):]
		if tag != "" && t != tag {
			continue
		}
		r := &Release{
			Version:   strings.TrimPrefix(t, "v"),
			Tag:       t,
			Name:      e.Title,
			NotesHTML: e.Content,
			URL:       href,
			Published: e.Updated,
		}
		if name := AssetName(runtime.GOOS, runtime.GOARCH); name != "" {
			r.AssetName = name
			r.AssetURL = WebBase + "/" + Repo + "/releases/download/" + t + "/" + name
			r.Digest = checksum(ctx, r.AssetURL+".sha256")
		}
		return r, nil
	}
	return nil, errors.New("릴리스를 찾을 수 없습니다")
}

// checksum reads "sha256:<hex>" from a .sha256 file ("" when there is none).
func checksum(ctx context.Context, url string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", "ArgusCode-updater")
	res, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ""
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
	f := strings.Fields(string(b))
	if len(f) == 0 || len(f[0]) != 64 {
		return ""
	}
	return "sha256:" + strings.ToLower(f[0])
}
