import { Extension } from '@codemirror/state';
import { LanguageDescription, LanguageSupport } from '@codemirror/language';
import { sql, MySQL, PostgreSQL, PLSQL, StandardSQL, SQLDialect, SQLNamespace } from '@codemirror/lang-sql';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { linter, Diagnostic } from '@codemirror/lint';
import { formatSql } from './sqlformat';
import { lintSql } from './sqllint';
import { sqlTools } from './sqltools';

const sqlToolsExt = sqlTools();
import type { Completion } from '@codemirror/autocomplete';
import type { SchemaTable } from './backend';

export type LangId = 'sql' | 'markdown' | 'json' | 'yaml' | 'javascript' | 'shell' | 'text';

export interface LangInfo {
  id: LangId;
  label: string; // status bar
  badge: string; // tree / tab badge
}

export const LANGS: Record<LangId, LangInfo> = {
  sql: { id: 'sql', label: 'SQL', badge: 'SQL' },
  markdown: { id: 'markdown', label: 'Markdown', badge: 'MD' },
  json: { id: 'json', label: 'JSON', badge: '{ }' },
  yaml: { id: 'yaml', label: 'YAML', badge: 'YML' },
  javascript: { id: 'javascript', label: 'JavaScript', badge: 'JS' },
  shell: { id: 'shell', label: 'Shell', badge: 'SH' },
  text: { id: 'text', label: 'Plain Text', badge: 'TXT' },
};

const EXT: Record<string, LangId> = {
  sql: 'sql',
  ddl: 'sql',
  dml: 'sql',
  pks: 'sql',
  pkb: 'sql',
  prc: 'sql',
  fnc: 'sql',
  trg: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  geojson: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function langForName(name: string): LangId {
  return EXT[extOf(name)] ?? 'text';
}

export function isSupported(name: string): boolean {
  return langForName(name) !== 'text';
}

// ---- SQL dialects ----------------------------------------------------------

export type DialectId = 'mysql' | 'postgresql' | 'plsql' | 'standard';

export const DIALECTS: Record<DialectId, { label: string; cm: SQLDialect }> = {
  mysql: { label: 'MySQL', cm: MySQL },
  postgresql: { label: 'PostgreSQL', cm: PostgreSQL },
  plsql: { label: 'Oracle', cm: PLSQL },
  standard: { label: 'Standard', cm: StandardSQL },
};

// ---- Extensions per language ----------------------------------------------

// Tables / columns found in the folder's DDL, used for completion.
let sqlSchema: SQLNamespace = {};
let upperKeywords = true;
const sqlCache = new Map<DialectId, LanguageSupport>();

// Rule-based DDL review linter (ddlreview.ts), set when a ruleset is loaded.
let ddlLintExt: Extension = [];
/** Installs (or removes, with []) the DDL review linter. Callers must reconfigure open SQL editors. */
export function setDdlLint(ext: Extension) {
  ddlLintExt = ext;
}

// Light SQL syntax check (sqllint.ts): mistakes are boxed like a selection —
// red for errors, amber for warnings — rather than underlined.
let sqlLintOn = true;
/** Turns the SQL syntax check on/off. Callers must reconfigure open SQL editors. */
export function setSqlLint(on: boolean) {
  sqlLintOn = on;
}
const sqlLintCache = new Map<DialectId, Extension>();
function sqlLintExt(dialect: DialectId): Extension {
  if (!sqlLintOn) return [];
  let ext = sqlLintCache.get(dialect);
  if (!ext) {
    ext = linter(
      (view) => {
        if (view.state.doc.length > 2_000_000) return [];
        return lintSql(view.state.doc.toString(), dialect).map((p) => ({
          from: p.from,
          to: Math.max(p.to, p.from + 1),
          severity: p.severity,
          source: 'SQL 문법',
          message: p.message,
          markClass: p.severity === 'error' ? 'cm-sql-bad' : 'cm-sql-warn',
        }));
      },
      { delay: 400 },
    );
    sqlLintCache.set(dialect, ext);
  }
  return ext;
}

/** Replaces the completion schema. Callers must reconfigure open SQL editors. */
export function setSqlSchema(ns: SQLNamespace) {
  sqlSchema = ns;
  sqlCache.clear();
}

/** Keyword case used by SQL autocomplete. Callers must reconfigure open SQL editors. */
export function setSqlKeywordCase(upper: boolean) {
  if (upper === upperKeywords) return;
  upperKeywords = upper;
  sqlCache.clear();
}

/** Builds a CodeMirror completion namespace from scanned DDL tables. */
export function schemaNamespace(tables: SchemaTable[]): SQLNamespace {
  const ns: Record<string, SQLNamespace> = {};
  const schemas: Record<string, { self: Completion; children: Record<string, SQLNamespace> }> = {};
  for (const t of tables) {
    const entry: SQLNamespace = {
      self: {
        label: t.name,
        type: t.kind === 'view' ? 'class' : 'type',
        detail: t.kind === 'view' ? 'view' : 'table',
        info: [t.comment, t.file].filter(Boolean).join(' · '),
      },
      children: (t.columns ?? []).map((c) => ({
        label: c.name,
        type: 'property',
        detail: c.type || undefined,
        info: c.comment || undefined,
      })),
    };
    if (!(t.name in ns)) ns[t.name] = entry;
    if (t.schema) {
      const s = (schemas[t.schema] ??= { self: { label: t.schema, type: 'namespace' }, children: {} });
      s.children[t.name] = entry;
    }
  }
  for (const [k, v] of Object.entries(schemas)) if (!(k in ns)) ns[k] = v;
  return ns;
}

function sqlSupport(d: DialectId): LanguageSupport {
  let s = sqlCache.get(d);
  if (!s) {
    s = sql({ dialect: DIALECTS[d].cm, upperCaseKeywords: upperKeywords, schema: sqlSchema });
    sqlCache.set(d, s);
  }
  return s;
}

/** The YAML library (~100 KB) is only loaded once a YAML file is used. */
export const loadYaml = () => import('yaml');

const yamlLinter = linter(
  async (view) => {
    const text = view.state.doc.toString();
    const out: Diagnostic[] = [];
    const { parseAllDocuments } = await loadYaml();
    try {
      for (const doc of parseAllDocuments(text)) {
        for (const e of [...doc.errors, ...doc.warnings]) {
          const from = Math.min(e.pos[0], text.length);
          const to = Math.min(Math.max(e.pos[1], from), text.length);
          out.push({
            from,
            to,
            severity: doc.errors.includes(e as any) ? 'error' : 'warning',
            message: e.message.split('\n')[0],
          });
        }
      }
    } catch {
      /* parser crashed: no diagnostics */
    }
    return out;
  },
  { delay: 400 },
);

const jsonLinter = linter(jsonParseLinter(), { delay: 400 });

// ---- Lazily loaded languages ----------------------------------------------------------
// JavaScript (~150 KB with mongosh tools) and shell load the first time such a
// file is opened; editors start as plain text and are reconfigured on load.

const loaded: Partial<Record<LangId, Extension>> = {};
const pending = new Set<LangId>();
let onLoaded: ((id: LangId) => void) | null = null;

/** Called when a lazily loaded language becomes available. */
export function onLanguageLoaded(fn: (id: LangId) => void) {
  onLoaded = fn;
}

function lazy(id: LangId): Extension {
  const ext = loaded[id];
  if (ext) return ext;
  if (!pending.has(id)) {
    pending.add(id);
    const p =
      id === 'javascript'
        ? import('./jslang').then((m) => m.jsExtension())
        : import('./shlang').then((m) => m.shExtension());
    p.then((e) => {
      loaded[id] = e;
      onLoaded?.(id);
    }).catch(() => pending.delete(id));
  }
  return [];
}

// Fenced code blocks in Markdown (```js / ```bash) load the same way.
const jsCode = LanguageDescription.of({
  name: 'javascript',
  load: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
});
const shCode = LanguageDescription.of({
  name: 'shell',
  load: () => import('./shlang').then((m) => new LanguageSupport(m.shLanguage)),
});

const mdSupport = markdown({
  base: markdownLanguage,
  codeLanguages: (info) => {
    const id = EXT[info.trim().toLowerCase()] ?? (info.trim().toLowerCase() as LangId);
    if (id === 'sql') return sqlSupport('mysql').language;
    if (id === 'json') return json().language;
    if (id === 'yaml') return yaml().language;
    if (id === 'javascript' || /^(mongo|mongosh|javascript)$/.test(info.trim())) return jsCode;
    if (id === 'shell' || /^(shell|console|shellsession)$/.test(info.trim())) return shCode;
    return null;
  },
});

export function languageExtension(id: LangId, dialect: DialectId, large = false): Extension {
  if (large) return []; // large-file mode: plain text, no parsing
  switch (id) {
    case 'sql':
      return [sqlSupport(dialect), sqlToolsExt, ddlLintExt, sqlLintExt(dialect)];
    case 'markdown':
      return mdSupport;
    case 'json':
      return [json(), jsonLinter];
    case 'yaml':
      return [yaml(), yamlLinter];
    case 'javascript':
    case 'shell':
      return lazy(id);
    default:
      return [];
  }
}

// ---- Formatting -----------------------------------------------------------

export async function formatText(
  id: LangId,
  text: string,
  opts: { dialect: DialectId; indent: number; fragment?: boolean; sqlStyle?: 'left' | 'river' },
): Promise<string> {
  switch (id) {
    case 'json': {
      return JSON.stringify(JSON.parse(text), null, opts.indent) + (opts.fragment ? '' : '\n');
    }
    case 'yaml': {
      const { parseAllDocuments } = await loadYaml();
      const docs = parseAllDocuments(text);
      for (const d of docs) if (d.errors.length) throw new Error(d.errors[0].message.split('\n')[0]);
      return docs.map((d) => d.toString({ indent: opts.indent })).join('');
    }
    case 'sql': {
      const out = formatSql(text, {
        dialect: opts.dialect,
        style: opts.sqlStyle ?? 'left',
        indent: opts.indent,
        tableIndent: Math.max(opts.indent, 4),
      });
      return out + (opts.fragment ? '' : '\n');
    }
    case 'javascript': {
      // js-beautify's JavaScript part only (~70 KB), loaded on first use; then
      // over-long lines are broken at their brackets (pipelines: one stage per line).
      const [{ default: beautify }, { wrapLongLines }] = await Promise.all([
        import('js-beautify/js/src/javascript/index.js'),
        import('./jswrap'),
      ]);
      const out = beautify(text, {
        indent_size: opts.indent,
        indent_char: ' ',
        preserve_newlines: true,
        max_preserve_newlines: 2,
        brace_style: 'collapse,preserve-inline',
        space_after_anon_function: false,
        end_with_newline: false,
      });
      return wrapLongLines(out, 100, ' '.repeat(opts.indent)) + (opts.fragment ? '' : '\n');
    }
    default:
      throw new Error('이 형식은 자동 정렬을 지원하지 않습니다.');
  }
}

export function canFormat(id: LangId): boolean {
  return id === 'json' || id === 'yaml' || id === 'sql' || id === 'javascript';
}
