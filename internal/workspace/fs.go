// Package workspace implements the file-system operations ArgusCode exposes
// to the frontend. It has no Wails dependency so it can be unit-tested alone.
package workspace

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxFileSize is the largest file the editor will open (bytes).
const MaxFileSize = 20 << 20

// MaxQuickOpenFiles caps the number of files returned by ListFiles.
const MaxQuickOpenFiles = 20000

// skipDirs are never shown in the tree nor walked for quick open.
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, ".idea": true, ".DS_Store": true,
	"__pycache__": true, ".venv": true,
}

// Entry is one row in the explorer tree.
type Entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Ext   string `json:"ext"`
	Size  int64  `json:"size"` // bytes (files only)
}

// FileContent is the result of reading a file.
type FileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	ModTime int64  `json:"modTime"` // unix millis
	EOL     string `json:"eol"`     // "LF" or "CRLF"
	BOM     bool   `json:"bom"`
}

// FileStat is a cheap freshness check for an open file.
type FileStat struct {
	Exists  bool  `json:"exists"`
	ModTime int64 `json:"modTime"`
	Size    int64 `json:"size"`
}

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// ErrBinary is returned when a file does not look like text.
var ErrBinary = errors.New("binary file: cannot be opened as text")

// ListDir returns the direct children of dir, directories first, then
// case-insensitive by name.
func ListDir(dir string) ([]Entry, error) {
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(items))
	for _, it := range items {
		name := it.Name()
		if skipDirs[name] || name == ".DS_Store" {
			continue
		}
		p := filepath.Join(dir, name)
		isDir := it.IsDir()
		if it.Type()&fs.ModeSymlink != 0 {
			if st, err := os.Stat(p); err == nil {
				isDir = st.IsDir()
			}
		}
		e := Entry{Name: name, Path: p, IsDir: isDir}
		if !isDir {
			e.Ext = strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
			if st, err := os.Stat(p); err == nil {
				e.Size = st.Size()
			}
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// ListFiles walks root and returns file paths relative to root (slash
// separated) for the quick-open palette.
func ListFiles(root string) ([]string, error) {
	var files []string
	errStop := errors.New("stop")
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if p != root && skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if d.Name() == ".DS_Store" {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return nil
		}
		files = append(files, filepath.ToSlash(rel))
		if len(files) >= MaxQuickOpenFiles {
			return errStop
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return nil, err
	}
	return files, nil
}

// ReadFile reads a UTF-8 text file. Line endings are normalised to LF; the
// original style is reported so it can be restored on save.
func ReadFile(path string) (*FileContent, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return nil, fmt.Errorf("%s is a directory", path)
	}
	if st.Size() > MaxFileSize {
		return nil, fmt.Errorf("file is too large (%d MB > %d MB)", st.Size()>>20, MaxFileSize>>20)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	bom := bytes.HasPrefix(b, utf8BOM)
	if bom {
		b = b[len(utf8BOM):]
	}
	if looksBinary(b) {
		return nil, ErrBinary
	}
	eol := "LF"
	if bytes.Contains(b, []byte("\r\n")) {
		eol = "CRLF"
		b = bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))
	}
	return &FileContent{
		Path:    path,
		Content: string(b),
		ModTime: st.ModTime().UnixMilli(),
		EOL:     eol,
		BOM:     bom,
	}, nil
}

func looksBinary(b []byte) bool {
	n := len(b)
	if n > 8000 {
		n = 8000
	}
	head := b[:n]
	if bytes.IndexByte(head, 0) >= 0 {
		return true
	}
	// Allow a truncated multi-byte rune at the cut point.
	for len(head) > 0 && !utf8.Valid(head) {
		if len(head) < n-3 {
			return true
		}
		head = head[:len(head)-1]
	}
	return false
}

// WriteFile atomically writes content (LF-separated) to path, converting to
// the requested EOL and optionally prefixing a BOM. Permissions of an
// existing file are preserved. Returns the new modification time.
func WriteFile(path, content, eol string, bom bool) (int64, error) {
	data := []byte(content)
	if eol == "CRLF" {
		data = bytes.ReplaceAll(data, []byte("\n"), []byte("\r\n"))
	}
	if bom {
		data = append(append([]byte{}, utf8BOM...), data...)
	}
	perm := fs.FileMode(0o644)
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm()
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".argus-*")
	if err != nil {
		// Directory not writable for temp files: fall back to direct write.
		if werr := os.WriteFile(path, data, perm); werr != nil {
			return 0, werr
		}
		return modTime(path), nil
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return 0, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return 0, err
	}
	_ = os.Chmod(tmpName, perm)
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return 0, err
	}
	return modTime(path), nil
}

func modTime(path string) int64 {
	if st, err := os.Stat(path); err == nil {
		return st.ModTime().UnixMilli()
	}
	return time.Now().UnixMilli()
}

// Stat reports whether a file exists and its modification time.
func Stat(path string) FileStat {
	st, err := os.Stat(path)
	if err != nil {
		return FileStat{}
	}
	return FileStat{Exists: true, ModTime: st.ModTime().UnixMilli(), Size: st.Size()}
}

func validName(name string) error {
	if name == "" || name == "." || name == ".." {
		return errors.New("invalid name")
	}
	if strings.ContainsAny(name, `/\:*?"<>|`) {
		return fmt.Errorf("name %q contains an invalid character", name)
	}
	return nil
}

// CreateFile creates an empty file named name inside dir. It fails if the
// file already exists.
func CreateFile(dir, name string) (string, error) {
	if err := validName(name); err != nil {
		return "", err
	}
	p := filepath.Join(dir, name)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	return p, f.Close()
}

// CreateDir creates a directory named name inside dir.
func CreateDir(dir, name string) (string, error) {
	if err := validName(name); err != nil {
		return "", err
	}
	p := filepath.Join(dir, name)
	if err := os.Mkdir(p, 0o755); err != nil {
		return "", err
	}
	return p, nil
}

// Rename renames path to newName within the same directory. It refuses to
// overwrite an existing entry.
func Rename(path, newName string) (string, error) {
	if err := validName(newName); err != nil {
		return "", err
	}
	np := filepath.Join(filepath.Dir(path), newName)
	if np == path {
		return path, nil
	}
	// Allow case-only renames on case-insensitive file systems.
	if _, err := os.Stat(np); err == nil && !strings.EqualFold(np, path) {
		return "", fmt.Errorf("%s already exists", newName)
	}
	if err := os.Rename(path, np); err != nil {
		return "", err
	}
	return np, nil
}
