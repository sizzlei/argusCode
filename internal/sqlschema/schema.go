// Package sqlschema extracts table and column definitions from DDL files so
// the editor can offer table/column completion without a database
// connection. It understands CREATE TABLE, CREATE VIEW, ALTER TABLE … ADD
// COLUMN and COMMENT ON TABLE/COLUMN (MySQL, PostgreSQL, Oracle syntax).
package sqlschema

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Column is one column of a table or view.
type Column struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Comment string `json:"comment,omitempty"`
	Line    int    `json:"line,omitempty"` // 1-based line of the definition
}

// Table is a table or view definition.
type Table struct {
	Schema  string   `json:"schema,omitempty"`
	Name    string   `json:"name"`
	Kind    string   `json:"kind"` // "table" or "view"
	Comment string   `json:"comment,omitempty"`
	File    string   `json:"file"`
	Line    int      `json:"line"` // 1-based line of CREATE …
	Columns []Column `json:"columns"`
}

// Limits keep scanning cheap on large repositories.
const (
	MaxFiles    = 3000
	MaxFileSize = 5 << 20
)

var skipDirs = map[string]bool{".git": true, "node_modules": true, ".idea": true, ".venv": true, "__pycache__": true}

// Scan parses every *.sql file under root. Later definitions of the same
// table replace earlier ones; ALTER/COMMENT statements amend them.
func Scan(ctx context.Context, root string) ([]Table, error) {
	set := newSet()
	n := 0
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
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
		ext := strings.ToLower(filepath.Ext(p))
		if ext != ".sql" && ext != ".ddl" {
			return nil
		}
		if n++; n > MaxFiles {
			return fs.SkipAll
		}
		if st, err := d.Info(); err != nil || st.Size() > MaxFileSize {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil || bytes.IndexByte(b, 0) >= 0 {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		set.parse(string(b), filepath.ToSlash(rel))
		return nil
	})
	if err != nil && ctx.Err() != nil {
		return nil, err
	}
	return set.list(), nil
}

// Parse extracts definitions from a single SQL text.
func Parse(src, file string) []Table {
	s := newSet()
	s.parse(src, file)
	return s.list()
}

// ---- tokenizer -----------------------------------------------------------------

type tokKind int

const (
	tWord tokKind = iota
	tQuoted
	tString
	tPunct
	tNumber
)

type tok struct {
	k    tokKind
	v    string // identifier unquoted / string unescaped / punctuation
	u    string // upper-case for words
	p    int    // byte offset in the source
	line int    // 1-based line number (filled by parse)
}

func tokenize(src string) []tok {
	var out []tok
	i, n := 0, len(src)
	for i < n {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '-' && i+1 < n && src[i+1] == '-', c == '#':
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && src[i+1] == '*':
			j := strings.Index(src[i+2:], "*/")
			if j < 0 {
				i = n
			} else {
				i += j + 4
			}
		case c == '\'':
			var b strings.Builder
			j := i + 1
			for j < n {
				if src[j] == '\\' && j+1 < n {
					b.WriteByte(src[j+1])
					j += 2
					continue
				}
				if src[j] == '\'' {
					if j+1 < n && src[j+1] == '\'' {
						b.WriteByte('\'')
						j += 2
						continue
					}
					break
				}
				b.WriteByte(src[j])
				j++
			}
			out = append(out, tok{k: tString, v: b.String(), p: i})
			i = j + 1
		case c == '`' || c == '"' || c == '[':
			end := c
			if c == '[' {
				end = ']'
			}
			j := strings.IndexByte(src[i+1:], end)
			if j < 0 {
				j = n - i - 1
			}
			out = append(out, tok{k: tQuoted, v: src[i+1 : i+1+j], p: i})
			i += j + 2
		case isWordByte(c):
			j := i
			for j < n && (isWordByte(src[j]) || (src[j] >= '0' && src[j] <= '9') || src[j] == '$') {
				j++
			}
			w := src[i:j]
			out = append(out, tok{k: tWord, v: w, u: strings.ToUpper(w), p: i})
			i = j
		case c >= '0' && c <= '9':
			j := i
			for j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] == '.') {
				j++
			}
			out = append(out, tok{k: tNumber, v: src[i:j], p: i})
			i = j
		default:
			out = append(out, tok{k: tPunct, v: string(c), p: i})
			i++
		}
	}
	return out
}

func isWordByte(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 0x80
}

func (t tok) is(u string) bool    { return t.k == tWord && t.u == u }
func (t tok) punct(p string) bool { return t.k == tPunct && t.v == p }
func (t tok) ident() bool         { return t.k == tWord || t.k == tQuoted }

// ---- parser -----------------------------------------------------------------------

type set struct {
	tables map[string]*Table
}

func newSet() *set { return &set{tables: map[string]*Table{}} }

func key(schema, name string) string { return strings.ToLower(schema + "." + name) }

func (s *set) find(schema, name string) *Table {
	if t, ok := s.tables[key(schema, name)]; ok {
		return t
	}
	if schema == "" {
		// Unqualified reference: match a table with any schema.
		for _, t := range s.tables {
			if strings.EqualFold(t.Name, name) {
				return t
			}
		}
	}
	return nil
}

func (s *set) list() []Table {
	out := make([]Table, 0, len(s.tables))
	for _, t := range s.tables {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool {
		if !strings.EqualFold(out[i].Name, out[j].Name) {
			return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
		}
		return out[i].Schema < out[j].Schema
	})
	return out
}

func (s *set) parse(src, file string) {
	toks := tokenize(src)
	// Line numbers for "go to definition".
	var nl []int
	for i := 0; i < len(src); i++ {
		if src[i] == '\n' {
			nl = append(nl, i)
		}
	}
	for i := range toks {
		toks[i].line = sort.SearchInts(nl, toks[i].p) + 1
	}
	// Split into statements at ';' (procedural bodies may confuse this, but
	// we only look at statements that start with CREATE/ALTER/COMMENT).
	start := 0
	for i := 0; i <= len(toks); i++ {
		if i == len(toks) || toks[i].punct(";") {
			if i > start {
				s.statement(toks[start:i], file)
			}
			start = i + 1
		}
	}
}

// name parses [schema.]name at toks[i]; returns schema, name, next index.
func name(toks []tok, i int) (string, string, int) {
	if i >= len(toks) || !toks[i].ident() {
		return "", "", i
	}
	a := toks[i].v
	if i+2 < len(toks) && toks[i+1].punct(".") && toks[i+2].ident() {
		return a, toks[i+2].v, i + 3
	}
	return "", a, i + 1
}

func skipWords(toks []tok, i int, words ...string) int {
	for i < len(toks) {
		matched := false
		for _, w := range words {
			if toks[i].is(w) {
				matched = true
				break
			}
		}
		if !matched {
			return i
		}
		i++
	}
	return i
}

func (s *set) statement(toks []tok, file string) {
	if len(toks) < 3 {
		return
	}
	switch {
	case toks[0].is("CREATE"):
		i := skipWords(toks, 1, "OR", "REPLACE", "GLOBAL", "LOCAL", "TEMPORARY", "TEMP", "UNLOGGED", "FORCE",
			"NOFORCE", "EDITIONABLE", "NONEDITIONABLE", "ALGORITHM", "SQL", "SECURITY", "DEFINER", "INVOKER",
			"MERGE", "UNDEFINED", "TEMPTABLE", "MATERIALIZED")
		// MySQL view options carry "= value" / "user@host".
		for i < len(toks) && !toks[i].is("TABLE") && !toks[i].is("VIEW") && i < 12 {
			i++
		}
		if i >= len(toks) {
			return
		}
		if toks[i].is("TABLE") {
			s.createTable(toks, i+1, file)
		} else if toks[i].is("VIEW") {
			s.createView(toks, i+1, file)
		}
	case toks[0].is("ALTER") && toks[1].is("TABLE"):
		s.alterTable(toks, 2)
	case toks[0].is("COMMENT") && toks[1].is("ON"):
		s.commentOn(toks)
	}
}

var constraintWords = map[string]bool{
	"CONSTRAINT": true, "PRIMARY": true, "KEY": true, "INDEX": true, "UNIQUE": true, "FOREIGN": true,
	"CHECK": true, "FULLTEXT": true, "SPATIAL": true, "PERIOD": true, "EXCLUDE": true, "LIKE": true,
}

var typeMods = map[string]bool{"UNSIGNED": true, "SIGNED": true, "ZEROFILL": true, "PRECISION": true, "VARYING": true}

// splitTop splits toks[from:to] at depth-0 commas.
func splitTop(toks []tok) [][]tok {
	var out [][]tok
	d, start := 0, 0
	for i, t := range toks {
		switch {
		case t.punct("("):
			d++
		case t.punct(")"):
			d--
		case t.punct(",") && d == 0:
			out = append(out, toks[start:i])
			start = i + 1
		}
	}
	return append(out, toks[start:])
}

func closeParen(toks []tok, i int) int {
	d := 0
	for j := i; j < len(toks); j++ {
		if toks[j].punct("(") {
			d++
		} else if toks[j].punct(")") {
			if d--; d == 0 {
				return j
			}
		}
	}
	return len(toks) - 1
}

func render(toks []tok) string {
	var b strings.Builder
	for i, t := range toks {
		switch {
		case t.punct("("):
			b.WriteByte('(')
		case t.punct(")"):
			b.WriteByte(')')
		case t.punct(","):
			b.WriteString(", ")
		default:
			if i > 0 && !toks[i-1].punct("(") && !toks[i-1].punct(",") {
				b.WriteByte(' ')
			}
			if t.k == tString {
				b.WriteString("'" + strings.ReplaceAll(t.v, "'", "''") + "'")
			} else {
				b.WriteString(t.v)
			}
		}
	}
	return b.String()
}

func (s *set) createTable(toks []tok, i int, file string) {
	i = skipWords(toks, i, "IF", "NOT", "EXISTS")
	schema, nm, i := name(toks, i)
	if nm == "" || i >= len(toks) || !toks[i].punct("(") {
		return // CREATE TABLE x AS SELECT / LIKE: no column list
	}
	end := closeParen(toks, i)
	t := &Table{Schema: schema, Name: nm, Kind: "table", File: file, Line: toks[0].line}
	for _, item := range splitTop(toks[i+1 : end]) {
		if len(item) == 0 || !item[0].ident() || (item[0].k == tWord && constraintWords[item[0].u]) {
			continue
		}
		c := Column{Name: item[0].v, Line: item[0].line}
		k := 1
		if k < len(item) && item[k].k == tWord {
			typ := []tok{item[k]}
			k++
			if k < len(item) && item[k].punct("(") {
				e := closeParen(item, k)
				typ = append(typ, item[k:e+1]...)
				k = e + 1
			}
			for k < len(item) && item[k].k == tWord && typeMods[item[k].u] {
				typ = append(typ, item[k])
				k++
			}
			c.Type = render(typ)
		}
		for ; k < len(item)-1; k++ {
			if item[k].is("COMMENT") && item[k+1].k == tString {
				c.Comment = item[k+1].v
			}
		}
		t.Columns = append(t.Columns, c)
	}
	// Table options: COMMENT='…' or COMMENT '…'
	for k := end + 1; k < len(toks)-1; k++ {
		if toks[k].is("COMMENT") {
			if toks[k+1].k == tString {
				t.Comment = toks[k+1].v
			} else if toks[k+1].punct("=") && k+2 < len(toks) && toks[k+2].k == tString {
				t.Comment = toks[k+2].v
			}
		}
	}
	s.tables[key(schema, nm)] = t
}

func (s *set) createView(toks []tok, i int, file string) {
	i = skipWords(toks, i, "IF", "NOT", "EXISTS")
	schema, nm, i := name(toks, i)
	if nm == "" {
		return
	}
	t := &Table{Schema: schema, Name: nm, Kind: "view", File: file, Line: toks[0].line}
	if i < len(toks) && toks[i].punct("(") {
		end := closeParen(toks, i)
		for _, it := range splitTop(toks[i+1 : end]) {
			if len(it) > 0 && it[0].ident() {
				t.Columns = append(t.Columns, Column{Name: it[0].v, Line: it[0].line})
			}
		}
	} else {
		// Output names of the first SELECT list.
		sel := -1
		for k := i; k < len(toks); k++ {
			if toks[k].is("SELECT") {
				sel = k + 1
				break
			}
		}
		if sel > 0 {
			d, end := 0, len(toks)
			for k := sel; k < len(toks); k++ {
				if toks[k].punct("(") {
					d++
				} else if toks[k].punct(")") {
					d--
				} else if d == 0 && toks[k].is("FROM") {
					end = k
					break
				}
			}
			for _, it := range splitTop(toks[sel:end]) {
				if n := len(it); n > 0 && it[n-1].ident() && !it[n-1].is("DISTINCT") {
					t.Columns = append(t.Columns, Column{Name: it[n-1].v, Line: it[n-1].line})
				}
			}
		}
	}
	s.tables[key(schema, nm)] = t
}

func (s *set) alterTable(toks []tok, i int) {
	i = skipWords(toks, i, "IF", "EXISTS", "ONLY")
	schema, nm, i := name(toks, i)
	t := s.find(schema, nm)
	if t == nil {
		return
	}
	for _, part := range splitTop(toks[i:]) {
		if len(part) < 3 || !part[0].is("ADD") {
			continue
		}
		k := skipWords(part, 1, "COLUMN", "IF", "NOT", "EXISTS")
		if k >= len(part) || !part[k].ident() || (part[k].k == tWord && constraintWords[part[k].u]) {
			continue
		}
		c := Column{Name: part[k].v, Line: part[k].line}
		if k+1 < len(part) && part[k+1].k == tWord {
			c.Type = part[k+1].v
			if k+2 < len(part) && part[k+2].punct("(") {
				e := closeParen(part, k+2)
				c.Type = render(part[k+1 : e+1])
			}
		}
		t.Columns = append(t.Columns, c)
	}
}

// COMMENT ON TABLE [schema.]t IS '…' / COMMENT ON COLUMN [schema.]t.c IS '…'
func (s *set) commentOn(toks []tok) {
	if len(toks) < 5 {
		return
	}
	isAt := -1
	for k := range toks {
		if toks[k].is("IS") {
			isAt = k
			break
		}
	}
	if isAt < 0 || isAt+1 >= len(toks) || toks[isAt+1].k != tString {
		return
	}
	text := toks[isAt+1].v
	var parts []string
	for _, t := range toks[3:isAt] {
		if t.ident() {
			parts = append(parts, t.v)
		}
	}
	switch {
	case toks[2].is("TABLE") && len(parts) >= 1:
		schema := ""
		if len(parts) == 2 {
			schema = parts[0]
		}
		if t := s.find(schema, parts[len(parts)-1]); t != nil {
			t.Comment = text
		}
	case toks[2].is("COLUMN") && len(parts) >= 2:
		schema := ""
		if len(parts) == 3 {
			schema = parts[0]
		}
		t := s.find(schema, parts[len(parts)-2])
		if t == nil {
			return
		}
		col := parts[len(parts)-1]
		for i := range t.Columns {
			if strings.EqualFold(t.Columns[i].Name, col) {
				t.Columns[i].Comment = text
			}
		}
	}
}
