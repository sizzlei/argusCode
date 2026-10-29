package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSearchOptionsAndColumns(t *testing.T) {
	d := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(d, "ddl"), 0o755))
	must(t, os.MkdirAll(filepath.Join(d, "node_modules"), 0o755))
	must(t, os.WriteFile(filepath.Join(d, "ddl", "orders.sql"), []byte("-- 주문 테이블\r\nCREATE TABLE orders (id INT);\r\nselect * from Orders;\r\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(d, "README.md"), []byte("orders 문서\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(d, "node_modules", "x.sql"), []byte("orders"), 0o644))
	must(t, os.WriteFile(filepath.Join(d, "bin.dat"), []byte{'o', 'r', 'd', 'e', 'r', 's', 0}, 0o644))

	res, err := Search(context.Background(), d, SearchOptions{Query: "orders"})
	must(t, err)
	if res.Total != 3 || len(res.Files) != 2 {
		t.Fatalf("total=%d files=%+v", res.Total, res.Files)
	}
	if res.Files[0].Rel != "README.md" || res.Files[1].Rel != "ddl/orders.sql" {
		t.Fatalf("order: %s, %s", res.Files[0].Rel, res.Files[1].Rel)
	}

	res, err = Search(context.Background(), d, SearchOptions{Query: "orders", CaseSensitive: true, Include: "*.sql"})
	must(t, err)
	if res.Total != 1 || res.Files[0].Matches[0].Line != 2 {
		t.Fatalf("case-sensitive include: %+v", res)
	}

	res, err = Search(context.Background(), d, SearchOptions{Query: "orders", Exclude: "ddl/"})
	must(t, err)
	if res.Total != 1 || res.Files[0].Rel != "README.md" {
		t.Fatalf("exclude: %+v", res)
	}

	// UTF-16 column after Korean text and whole word.
	ms, err := SearchText("한글 orders x_orders", SearchOptions{Query: "orders", WholeWord: true})
	must(t, err)
	if len(ms) != 1 || ms[0].Col != 3 || ms[0].Len != 6 {
		t.Fatalf("matches = %+v", ms)
	}
	// Astral characters count as two code units.
	ms, _ = SearchText("😀a", SearchOptions{Query: "a"})
	if ms[0].Col != 2 {
		t.Fatalf("col = %d, want 2", ms[0].Col)
	}
}

func TestReplace(t *testing.T) {
	out, n, err := ReplaceText("a.b a.b\naxb", SearchOptions{Query: "a.b"}, "c")
	must(t, err)
	if out != "c c\naxb" || n != 2 {
		t.Fatalf("literal: %q %d", out, n)
	}
	out, n, err = ReplaceText("user_id INT\norder_id INT", SearchOptions{Query: `(\w+)_id`, Regex: true}, "${1}_no")
	must(t, err)
	if out != "user_no INT\norder_no INT" || n != 2 {
		t.Fatalf("regex: %q %d", out, n)
	}
	// \s+ must not join lines.
	out, _, _ = ReplaceText("a  \nb", SearchOptions{Query: `\s+`, Regex: true}, " ")
	if out != "a \nb" {
		t.Fatalf("per-line: %q", out)
	}

	p := filepath.Join(t.TempDir(), "q.sql")
	must(t, os.WriteFile(p, []byte("SELECT 1;\r\nSELECT 2;\r\n"), 0o644))
	n, err = ReplaceInFile(p, SearchOptions{Query: "select"}, "select")
	must(t, err)
	b, _ := os.ReadFile(p)
	if n != 2 || string(b) != "select 1;\r\nselect 2;\r\n" {
		t.Fatalf("file: %d %q", n, b)
	}
}

func TestSearchCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Search(ctx, t.TempDir(), SearchOptions{Query: "x"}); err == nil {
		t.Fatal("expected cancellation error")
	}
}
