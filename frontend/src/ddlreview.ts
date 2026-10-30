// Editor side of the DDL review: loads the user's ruleset (YAML) and turns
// findings into CodeMirror diagnostics (underlines + the problems panel).
// Loaded on demand only when a ruleset file is configured.

import type { Extension } from '@codemirror/state';
import { linter, type Diagnostic } from '@codemirror/lint';
import { parseDdl, looksLikeDdl, type DdlDialect } from './ddlparse.ts';
import { compileRules, review, templateYaml, type Rule } from './ddlrules.ts';

export { templateYaml };

export interface LoadedRules {
  rules: Rule[];
  errors: string[];
}

/** Parses ruleset YAML; syntax errors come back in `errors`. */
export async function loadRuleset(text: string): Promise<LoadedRules> {
  const { parse } = await import('yaml');
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { rules: [], errors: ['YAML 문법 오류: ' + String((e as Error).message).split('\n')[0]] };
  }
  return compileRules(doc);
}

/** Linter extension for SQL editors; `onResult` fires after each run. */
export function ddlLinter(rules: Rule[], dialect: () => DdlDialect, onResult: () => void): Extension {
  return linter(
    (view) => {
      const text = view.state.doc.toString();
      if (!looksLikeDdl(text)) {
        setTimeout(onResult, 30);
        return [];
      }
      const findings = review(parseDdl(text, dialect()), rules, dialect());
      const out: Diagnostic[] = findings.map((f) => ({
        from: Math.min(f.from, text.length),
        to: Math.min(f.to, text.length),
        severity: f.severity,
        source: 'DDL 검토',
        message: (f.id ? `[${f.id}] ` : '') + f.message,
      }));
      // after CodeMirror has stored the diagnostics in the state
      setTimeout(onResult, 30);
      return out;
    },
    { delay: 500 },
  );
}
