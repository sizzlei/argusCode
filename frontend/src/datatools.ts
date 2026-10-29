// JSON / YAML conversions used by the editor menu. The YAML library is
// loaded lazily.

const loadYaml = () => import('yaml');

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort((a, b) => a.localeCompare(b))) out[k] = sortDeep((v as any)[k]);
    return out;
  }
  return v;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 형식 오류: ' + (e instanceof Error ? e.message : String(e)));
  }
}

export function jsonMinify(text: string): string {
  return JSON.stringify(parseJson(text));
}

export function jsonSortKeys(text: string, indent: number): string {
  return JSON.stringify(sortDeep(parseJson(text)), null, indent) + '\n';
}

export async function jsonToYaml(text: string, indent: number): Promise<string> {
  const { stringify } = await loadYaml();
  return stringify(parseJson(text), { indent });
}

async function parseYamlDocs(text: string) {
  const { parseAllDocuments } = await loadYaml();
  const docs = parseAllDocuments(text);
  for (const d of docs) if (d.errors.length) throw new Error('YAML 형식 오류: ' + d.errors[0].message.split('\n')[0]);
  return docs;
}

export async function yamlToJson(text: string, indent: number): Promise<string> {
  const docs = await parseYamlDocs(text);
  const values = docs.map((d) => d.toJS());
  return JSON.stringify(values.length === 1 ? values[0] : values, null, indent) + '\n';
}

export async function yamlSortKeys(text: string, indent: number): Promise<string> {
  const { visit, isScalar } = await loadYaml();
  const docs = await parseYamlDocs(text);
  const keyOf = (k: unknown) => String(isScalar(k) ? k.value : k);
  for (const d of docs) {
    // A comment at the top of the file belongs to the document, not to
    // whichever key happens to come first.
    const first = (d.contents as any)?.items?.[0];
    if (first?.key?.commentBefore && !d.commentBefore) {
      d.commentBefore = first.key.commentBefore;
      first.key.commentBefore = undefined;
    }
    // Other comments are attached to their pairs, so they move with them.
    visit(d, {
      Map(_, map) {
        map.items.sort((a, b) => keyOf(a.key).localeCompare(keyOf(b.key)));
      },
    });
  }
  return docs.map((d) => d.toString({ indent })).join('');
}
