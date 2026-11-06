package platform

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestNormalizeDropPath(t *testing.T) {
	cases := map[string]string{
		"/Users/a/x.sql":                          "/Users/a/x.sql",
		"  /Users/a/x.sql\r\n":                    "/Users/a/x.sql",
		"file:///Users/a/My%20Docs/%ED%95%9C.sql": "/Users/a/My Docs/한.sql",
		"file://localhost/tmp/a.md":               "/tmp/a.md",
		"https://example.com/a.sql":               "",
		"":                                        "",
		"/tmp/../tmp/b.json":                      "/tmp/b.json",
	}
	for in, want := range cases {
		if want != "" {
			want = filepath.FromSlash(want)
		}
		if got := NormalizeDropPath(in); got != want {
			t.Errorf("NormalizeDropPath(%q) = %q, want %q", in, got, want)
		}
	}
	if runtime.GOOS == "windows" {
		if got := NormalizeDropPath("file:///C:/Work/a.sql"); got != `C:\Work\a.sql` {
			t.Errorf("windows drive URL: %q", got)
		}
	}
	if runtime.GOOS != "darwin" && NormalizeDropPath("/.file/id=6571367.2773272") != "" {
		t.Error("file reference should not resolve off macOS")
	}
}

func TestNormalizeDropPaths(t *testing.T) {
	got := NormalizeDropPaths([]string{"/a/x.sql\n/a/y.sql", "/a/x.sql", "", "http://x/y"})
	want := []string{filepath.FromSlash("/a/x.sql"), filepath.FromSlash("/a/y.sql")}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %q, want %q", got, want)
	}
}
