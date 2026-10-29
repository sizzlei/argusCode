import { Extension } from '@codemirror/state';
import { LanguageSupport } from '@codemirror/language';
import { sql, MySQL, PostgreSQL, PLSQL, StandardSQL, SQLDialect } from '@codemirror/lang-sql';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { linter, Diagnostic } from '@codemirror/lint';
import { parseAllDocuments } from 'yaml';

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

export const DIALECTS: Record<DialectId, { label: string; cm: SQLDialect; formatter: string }> = {
  mysql: { label: 'MySQL', cm: MySQL, formatter: 'mysql' },
  postgresql: { label: 'PostgreSQL', cm: PostgreSQL, formatter: 'postgresql' },
  plsql: { label: 'Oracle', cm: PLSQL, formatter: 'plsql' },
  standard: { label: 'Standard', cm: StandardSQL, formatter: 'sql' },
};

// ---- Extensions per language ----------------------------------------------

const sqlCache = new Map<DialectId, LanguageSupport>();
function sqlSupport(d: DialectId): LanguageSupport {
  let s = sqlCache.get(d);
  if (!s) {
    s = sql({ dialect: DIALECTS[d].cm, upperCaseKeywords: true });
    sqlCache.set(d, s);
  }
  return s;
}

const yamlLinter = linter(
  (view) => {
    const text = view.state.doc.toString();
    const out: Diagnostic[] = [];
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

export function languageExtension(id: LangId, dialect: DialectId): Extension {
  switch (id) {
    case 'sql':
      return sqlSupport(dialect);
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
  opts: { dialect: DialectId; indent: number },
): Promise<string> {
  switch (id) {
    case 'json': {
      return JSON.stringify(JSON.parse(text), null, opts.indent) + '\n';
    }
    case 'yaml': {
      const docs = parseAllDocuments(text);
      for (const d of docs) if (d.errors.length) throw new Error(d.errors[0].message.split('\n')[0]);
      return docs.map((d) => d.toString({ indent: opts.indent })).join('');
    }
    case 'sql': {
      const { format } = await import('sql-formatter');
      return (
        format(text, {
          language: DIALECTS[opts.dialect].formatter as any,
          keywordCase: 'upper',
          tabWidth: opts.indent,
          linesBetweenQueries: 1,
        }) + '\n'
      );
    }
    default:
      throw new Error('이 형식은 자동 정렬을 지원하지 않습니다.');
  }
}

export function canFormat(id: LangId): boolean {
  return id === 'json' || id === 'yaml' || id === 'sql';
}
