// Editor side of the DDL review: loads the user's ruleset (YAML) and turns
// findings — plus the built-in online DDL impact check — into CodeMirror
// diagnostics (underlines + the review panel). Loaded on demand.

import type { Extension } from '@codemirror/state';
import { linter, type Diagnostic } from '@codemirror/lint';
import { parseDdl, looksLikeDdl, type DdlDialect } from './ddlparse.ts';
import { compileRules, review, templateYaml, type Rule } from './ddlrules.ts';
import { analyzeImpact, type BeforeLookup } from './ddlimpact.ts';

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

/**
 * Linter extension for SQL editors; `onResult` fires after each run.
 * `impact` (when given) returns the lookup of the folder's CREATE TABLEs for
 * the online DDL impact check; null turns the check off.
 */
export function ddlLinter(
  rules: Rule[],
  dialect: () => DdlDialect,
  onResult: () => void,
  impact: () => BeforeLookup | null = () => null,
): Extension {
  return linter(
    (view) => {
      const text = view.state.doc.toString();
      if (!looksLikeDdl(text)) {
        setTimeout(onResult, 30);
        return [];
      }
      const stmts = parseDdl(text, dialect());
      const findings = rules.length ? review(stmts, rules, dialect()) : [];
      const out: Diagnostic[] = findings.map((f) => ({
        from: Math.min(f.from, text.length),
        to: Math.min(f.to, text.length),
        severity: f.severity,
        source: 'DDL 검토',
        message: (f.id ? `[${f.id}] ` : '') + f.message,
      }));
      const lookup = impact();
      if (lookup)
        for (const f of analyzeImpact(text, stmts, dialect(), lookup))
          out.push({
            from: Math.min(f.from, text.length),
            to: Math.min(f.to, text.length),
            severity: f.severity,
            source: 'DDL 검토',
            message: '[온라인 DDL] ' + f.message,
          });
      // after CodeMirror has stored the diagnostics in the state
      setTimeout(onResult, 30);
      return out;
    },
    { delay: 500 },
  );
}
