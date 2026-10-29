package watch

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func TestWatcherBatches(t *testing.T) {
	dir := t.TempDir()
	got := make(chan []string, 4)
	w, err := New(50*time.Millisecond, func(p []string) { got <- p })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	w.SetDirs([]string{dir})

	f := filepath.Join(dir, "a.sql")
	if err := os.WriteFile(f, []byte("select 1"), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case paths := <-got:
		sort.Strings(paths)
		if len(paths) != 2 || paths[0] != dir || paths[1] != f {
			t.Fatalf("paths = %v", paths)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no event")
	}

	// After un-watching, changes are no longer reported.
	w.SetDirs(nil)
	_ = os.WriteFile(filepath.Join(dir, "b.sql"), nil, 0o644)
	select {
	case p := <-got:
		t.Fatalf("unexpected event %v", p)
	case <-time.After(300 * time.Millisecond):
	}
}
