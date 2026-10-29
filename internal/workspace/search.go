package workspace

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"
)

// SearchOptions controls a find-in-files query.
type SearchOptions struct {
	Query         string `json:"query"`
	CaseSensitive bool   `json:"caseSensitive"`
	WholeWord     bool   `json:"wholeWord"`
	Regex         bool   `json:"regex"`
	// Include / Exclude are comma separated glob lists. A pattern without a
	// slash matches the file name ("*.sql"); with a slash it matches the path
	// relative to the root ("db/ddl/*.sql") or a directory prefix ("docs/").
	Include string `json:"include"`
	Exclude string `json:"exclude"`
}

// Match is one hit. Line is 1-based; Col and Len are in UTF-16 code units so
// they map directly onto JavaScript / CodeMirror string offsets.
type Match struct {
	Line   int    `json:"line"`
	Col    int    `json:"col"`
	Len    int    `json:"len"`
	Before string `json:"before"`
	Text   string `json:"text"`
	After  string `json:"after"`
}

// FileMatches groups the matches of one file.
type FileMatches struct {
	Path    string  `json:"path"`
	Rel     string  `json:"rel"`
	Matches []Match `json:"matches"`
}

// SearchResult is the answer to a find-in-files query.
type SearchResult struct {
	Files         []FileMatches `json:"files"`
	Total         int           `json:"total"`
	FilesSearched int           `json:"filesSearched"`
	Truncated     bool          `json:"truncated"`
}

// MaxSearchMatches caps the number of matches returned by Search.
const MaxSearchMatches = 5000

const (
	previewBefore = 40
	previewAfter  = 120
)

// CompilePattern turns the options into a regular expression (RE2 syntax).
func CompilePattern(o SearchOptions) (*regexp.Regexp, error) {
	if o.Query == "" {
		return nil, errors.New("empty query")
	}
	p := o.Query
	if !o.Regex {
		p = regexp.QuoteMeta(p)
	}
	if o.WholeWord {
		p = `\b(?:` + p + `)\b`
	}
	if !o.CaseSensitive {
		p = `(?i)` + p
	}
	// (?m) so ^ and $ work per line when the pattern is run on whole text.
	return regexp.Compile(`(?m)` + p)
}

type globSet []string

func parseGlobs(s string) globSet {
	var out globSet
	for _, g := range strings.Split(s, ",") {
		if g = strings.TrimSpace(g); g != "" {
			out = append(out, filepath.ToSlash(g))
		}
	}
	return out
}

// match reports whether rel (slash separated) is matched by any pattern.
func (gs globSet) match(rel string) bool {
	base := rel[strings.LastIndex(rel, "/")+1:]
	for _, g := range gs {
		if !strings.Contains(g, "/") {
			if ok, _ := filepath.Match(g, base); ok {
				return true
			}
			// Bare directory names ("node_modules", "backup") match any path segment.
			if !strings.ContainsAny(g, "*?[") && strings.Contains("/"+rel+"/", "/"+g+"/") {
				return true
			}
			continue
		}
		g = strings.TrimPrefix(g, "./")
		if strings.HasSuffix(g, "/") {
			if strings.HasPrefix(rel, g) {
				return true
			}
			continue
		}
		if ok, _ := filepath.Match(g, rel); ok {
			return true
		}
		if strings.HasPrefix(rel, g+"/") {
			return true
		}
	}
	return false
}

// Search scans every text file under root for the pattern. It stops early
// when ctx is cancelled (a newer search started).
func Search(ctx context.Context, root string, o SearchOptions) (*SearchResult, error) {
	re, err := CompilePattern(o)
	if err != nil {
		return nil, err
	}
	include, exclude := parseGlobs(o.Include), parseGlobs(o.Exclude)

	paths := make(chan [2]string, 256)
	var walkErr error
	go func() {
		defer close(paths)
		walkErr = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err != nil {
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			rel, _ := filepath.Rel(root, p)
			rel = filepath.ToSlash(rel)
			if d.IsDir() {
				if p != root && (skipDirs[d.Name()] || (len(exclude) > 0 && exclude.match(rel))) {
					return fs.SkipDir
				}
				return nil
			}
			if !d.Type().IsRegular() || d.Name() == ".DS_Store" {
				return nil
			}
			if len(include) > 0 && !include.match(rel) {
				return nil
			}
			if len(exclude) > 0 && exclude.match(rel) {
				return nil
			}
			select {
			case paths <- [2]string{p, rel}:
			case <-ctx.Done():
				return ctx.Err()
			}
			return nil
		})
	}()

	var (
		mu       sync.Mutex
		files    []FileMatches
		total    atomic.Int64
		searched atomic.Int64
		wg       sync.WaitGroup
	)
	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for pr := range paths {
				if ctx.Err() != nil || total.Load() >= MaxSearchMatches {
					continue // drain
				}
				st, err := os.Stat(pr[0])
				if err != nil || st.Size() > MaxFileSize {
					continue
				}
				b, err := os.ReadFile(pr[0])
				if err != nil {
					continue
				}
				b = bytes.TrimPrefix(b, utf8BOM)
				if looksBinary(b) {
					continue
				}
				searched.Add(1)
				ms := searchText(string(b), re, MaxSearchMatches)
				if len(ms) == 0 {
					continue
				}
				total.Add(int64(len(ms)))
				mu.Lock()
				files = append(files, FileMatches{Path: pr[0], Rel: pr[1], Matches: ms})
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if walkErr != nil && !errors.Is(walkErr, context.Canceled) {
		return nil, walkErr
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Rel < files[j].Rel })
	res := &SearchResult{Files: files, FilesSearched: int(searched.Load())}
	// Enforce the global cap deterministically after sorting.
	n := 0
	for i := range res.Files {
		if n+len(res.Files[i].Matches) > MaxSearchMatches {
			res.Files[i].Matches = res.Files[i].Matches[:MaxSearchMatches-n]
			res.Files = res.Files[:i+1]
			res.Truncated = true
			n = MaxSearchMatches
			break
		}
		n += len(res.Files[i].Matches)
	}
	if total.Load() > int64(n) {
		res.Truncated = true
	}
	res.Total = n
	return res, nil
}

// SearchText finds matches in an in-memory document (used for unsaved
// editors so results reflect what the user sees).
func SearchText(text string, o SearchOptions) ([]Match, error) {
	re, err := CompilePattern(o)
	if err != nil {
		return nil, err
	}
	return searchText(text, re, MaxSearchMatches), nil
}

func searchText(text string, re *regexp.Regexp, limit int) []Match {
	var out []Match
	line := 0
	for len(text) > 0 || line == 0 {
		line++
		var l string
		if i := strings.IndexByte(text, '\n'); i >= 0 {
			l, text = text[:i], text[i+1:]
		} else {
			l, text = text, ""
		}
		l = strings.TrimSuffix(l, "\r")
		for _, loc := range re.FindAllStringIndex(l, -1) {
			if loc[0] == loc[1] {
				continue // ignore empty matches (e.g. "^")
			}
			out = append(out, makeMatch(line, l, loc[0], loc[1]))
			if len(out) >= limit {
				return out
			}
		}
		if text == "" {
			break
		}
	}
	return out
}

func makeMatch(line int, l string, start, end int) Match {
	before := l[:start]
	if utf8.RuneCountInString(before) > previewBefore {
		r := []rune(before)
		before = "…" + string(r[len(r)-previewBefore:])
	}
	after := l[end:]
	if utf8.RuneCountInString(after) > previewAfter {
		after = string([]rune(after)[:previewAfter]) + "…"
	}
	return Match{
		Line:   line,
		Col:    utf16Len(l[:start]),
		Len:    utf16Len(l[start:end]),
		Before: strings.TrimLeft(before, " \t"),
		Text:   l[start:end],
		After:  after,
	}
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2 // surrogate pair
		} else {
			n++
		}
	}
	return n
}

// ReplaceText applies the replacement to every match in text, line by line
// (the same unit Search uses, so a pattern never spans lines). In regex mode
// the replacement may reference groups as $1 / ${1} / ${name}.
func ReplaceText(text string, o SearchOptions, repl string) (string, int, error) {
	re, err := CompilePattern(o)
	if err != nil {
		return "", 0, err
	}
	lines := strings.Split(text, "\n")
	n := 0
	for i, l := range lines {
		cnt := 0
		for _, loc := range re.FindAllStringIndex(l, -1) {
			if loc[0] != loc[1] {
				cnt++
			}
		}
		if cnt == 0 {
			continue
		}
		n += cnt
		if o.Regex {
			lines[i] = re.ReplaceAllString(l, repl)
		} else {
			lines[i] = re.ReplaceAllLiteralString(l, repl)
		}
	}
	return strings.Join(lines, "\n"), n, nil
}

// ReplaceInFile rewrites a file on disk, keeping its EOL style and BOM.
// Returns the number of replacements.
func ReplaceInFile(path string, o SearchOptions, repl string) (int, error) {
	fc, err := ReadFile(path)
	if err != nil {
		return 0, err
	}
	out, n, err := ReplaceText(fc.Content, o, repl)
	if err != nil || n == 0 {
		return 0, err
	}
	if _, err := WriteFile(path, out, fc.EOL, fc.BOM); err != nil {
		return 0, err
	}
	return n, nil
}
