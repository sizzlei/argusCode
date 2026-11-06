package platform

import (
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
)

// NormalizeDropPath turns what the OS hands over for a dropped or opened file
// into a plain file-system path: it accepts file:// URLs (URL-encoded),
// resolves macOS file reference URLs (/.file/id=…) and trims stray
// whitespace. An empty result means the item is not a local file.
func NormalizeDropPath(p string) string {
	p = strings.TrimSpace(strings.TrimRight(p, "\r\n\x00"))
	if p == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(p), "file:") {
		u, err := url.Parse(p)
		if err != nil {
			return ""
		}
		if u.Host != "" && u.Host != "localhost" {
			// UNC share: file://server/share/x
			p = `\\` + u.Host + filepath.FromSlash(u.Path)
		} else {
			p = u.Path
		}
		if runtime.GOOS == "windows" && len(p) >= 3 && p[0] == '/' && p[2] == ':' {
			p = p[1:] // /C:/x → C:/x
		}
	} else if strings.Contains(p, "://") {
		return "" // http:// etc.
	}
	if strings.HasPrefix(p, "/.file/id=") {
		p = resolveFileReference(p)
		if p == "" {
			return ""
		}
	}
	return filepath.Clean(filepath.FromSlash(p))
}

// NormalizeDropPaths applies NormalizeDropPath and drops empty and duplicate entries.
func NormalizeDropPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, raw := range paths {
		// Some sources join several paths with newlines.
		for _, part := range strings.Split(raw, "\n") {
			if p := NormalizeDropPath(part); p != "" && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}
