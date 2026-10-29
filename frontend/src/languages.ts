import { Extension } from '@codemirror/state';
import { LanguageSupport } from '@codemirror/language';
import { sql, MySQL, PostgreSQL, PLSQL, StandardSQL, SQLDialect, SQLNamespace } from '@codemirror/lang-sql';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { linter, Diagnostic } from '@codemirror/lint';
import { formatSql } from './sqlformat';
import { sqlTools } from './sqltools';

const sqlToolsExt = sqlTools();
import type { Completion } from '@codemirror/autocomplete';
import type { SchemaTable } from './backend';

export type LangId = 'sql' | 'markdown' | 'json' | 'yaml' | 'text';

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

const mdSupport = markdown({
  base: markdownLanguage,
  codeLanguages: (info) => {
    const id = EXT[info.trim().toLowerCase()] ?? (info.trim().toLowerCase() as LangId);
    if (id === 'sql') return sqlSupport('mysql').language;
    if (id === 'json') return json().language;
    if (id === 'yaml') return yaml().language;
    return null;
  },
});

export function languageExtension(id: LangId, dialect: DialectId, large = false): Extension {
  if (large) return []; // large-file mode: plain text, no parsing
  switch (id) {
    case 'sql':
      return [sqlSupport(dialect), sqlToolsExt];
    case 'markdown':
      return mdSupport;
    case 'json':
      return [json(), jsonLinter];
    case 'yaml':
      return [yaml(), yamlLinter];
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
    default:
      throw new Error('이 형식은 자동 정렬을 지원하지 않습니다.');
  }
}

export function canFormat(id: LangId): boolean {
  return id === 'json' || id === 'yaml' || id === 'sql';
}
