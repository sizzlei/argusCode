package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListDirOrderAndSkip(t *testing.T) {
	d := t.TempDir()
	must(t, os.Mkdir(filepath.Join(d, "zeta"), 0o755))
	must(t, os.Mkdir(filepath.Join(d, ".git"), 0o755))
	must(t, os.WriteFile(filepath.Join(d, "B.sql"), nil, 0o644))
	must(t, os.WriteFile(filepath.Join(d, "a.yaml"), nil, 0o644))

	got, err := ListDir(d)
	must(t, err)
	want := []string{"zeta", "a.yaml", "B.sql"}
	if len(got) != len(want) {
		t.Fatalf("got %d entries, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Name != w {
			t.Errorf("entry %d = %s, want %s", i, got[i].Name, w)
		}
	}
	if got[2].Ext != "sql" {
		t.Errorf("ext = %q, want sql", got[2].Ext)
	}
}

func TestReadWriteRoundTripCRLFAndBOM(t *testing.T) {
	p := filepath.Join(t.TempDir(), "q.sql")
	raw := append([]byte{0xEF, 0xBB, 0xBF}, []byte("SELECT 1;\r\nSELECT 2;\r\n")...)
	must(t, os.WriteFile(p, raw, 0o600))

	fc, err := ReadFile(p)
	must(t, err)
	if fc.EOL != "CRLF" || !fc.BOM {
		t.Fatalf("eol=%s bom=%v", fc.EOL, fc.BOM)
	}
	if fc.Content != "SELECT 1;\nSELECT 2;\n" {
		t.Fatalf("content not normalised: %q", fc.Content)
	}

	_, err = WriteFile(p, fc.Content+"SELECT 3;\n", fc.EOL, fc.BOM)
	must(t, err)
	b, _ := os.ReadFile(p)
	want := string(raw) + "SELECT 3;\r\n"
	if string(b) != want {
		t.Fatalf("written %q, want %q", b, want)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Errorf("perm = %v, want 0600", st.Mode().Perm())
	}
}

func TestReadFileRejectsBinary(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.bin")
	must(t, os.WriteFile(p, []byte{1, 2, 0, 3}, 0o644))
	if _, err := ReadFile(p); err != ErrBinary {
		t.Fatalf("err = %v, want ErrBinary", err)
	}
}

func TestReadFileKoreanText(t *testing.T) {
	p := filepath.Join(t.TempDir(), "k.md")
	must(t, os.WriteFile(p, []byte("# 한글 문서\n본문"), 0o644))
	fc, err := ReadFile(p)
	must(t, err)
	if fc.Content != "# 한글 문서\n본문" {
		t.Fatalf("got %q", fc.Content)
	}
}

func TestCreateRename(t *testing.T) {
	d := t.TempDir()
	p, err := CreateFile(d, "new.json")
	must(t, err)
	if _, err := CreateFile(d, "new.json"); err == nil {
		t.Fatal("expected error creating duplicate file")
	}
	if _, err := CreateFile(d, "../evil.sql"); err == nil {
		t.Fatal("expected error for path traversal name")
	}
	np, err := Rename(p, "renamed.json")
	must(t, err)
	if filepath.Base(np) != "renamed.json" {
		t.Fatalf("renamed to %s", np)
	}
	_, err = CreateDir(d, "sub")
	must(t, err)
	if _, err := Rename(np, "sub"); err == nil {
		t.Fatal("expected error renaming onto existing entry")
	}
}

func TestListFilesSkipsGit(t *testing.T) {
	d := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(d, ".git", "objects"), 0o755))
	must(t, os.WriteFile(filepath.Join(d, ".git", "HEAD"), nil, 0o644))
	must(t, os.MkdirAll(filepath.Join(d, "db", "ddl"), 0o755))
	must(t, os.WriteFile(filepath.Join(d, "db", "ddl", "t.sql"), nil, 0o644))
	files, err := ListFiles(d)
	must(t, err)
	if len(files) != 1 || files[0] != "db/ddl/t.sql" {
		t.Fatalf("files = %v", files)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
