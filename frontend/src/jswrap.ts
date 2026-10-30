// Breaks over-long JavaScript lines at their outermost brackets, one element
// per line — so an aggregation pipeline becomes one stage per line:
//
//   db.orders.aggregate([
//     { $match: { status: 'PAID' } },
//     { $group: { _id: '$memberId', total: { $sum: '$amount' } } },
//   ]);
//
// Runs after js-beautify (which keeps short literals inline). A call whose
// only argument is an object/array "hugs" it: `find({` / `aggregate([`.
// Strings, template literals, regex literals and comments are respected; a
// line it cannot fully understand is left as it is. No dependencies.

interface Group {
  open: number;
  close: number;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * Finds the top-level bracket groups of a line and the positions of its
 * top-level commas. Returns null when the line has unbalanced brackets or an
 * unterminated string (e.g. it continues on the next line).
 */
function scan(s: string): { groups: Group[]; commas: number[]; end: number } | null {
  const stack: { ch: string; pos: number }[] = [];
  const groups: Group[] = [];
  const commas: number[] = [];
  let prev = ''; // previous significant character (for regex detection)
  let i = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') i++;
        i++;
      }
      if (i >= s.length) return null;
      prev = q;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') break; // line comment: stop here
    if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      if (e < 0) return null;
      i = e + 1;
      continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
      // regex literal
      let cls = false;
      i++;
      while (i < s.length && (s[i] !== '/' || cls)) {
        if (s[i] === '\\') i++;
        else if (s[i] === '[') cls = true;
        else if (s[i] === ']') cls = false;
        i++;
      }
      if (i >= s.length) return null;
      while (/[a-z]/i.test(s[i + 1] ?? '')) i++; // flags
      prev = '/';
      continue;
    }
    if (OPEN[c]) stack.push({ ch: c, pos: i });
    else if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (!top || OPEN[top.ch] !== c) return null;
      if (!stack.length) groups.push({ open: top.pos, close: i });
    } else if (c === ',' && !stack.length) commas.push(i);
    if (!/\s/.test(c)) prev = c;
  }
  if (stack.length) return null;
  return { groups, commas, end: i };
}

/** Splits text at its top-level commas (trimmed, empty trailing element dropped). */
function splitTop(s: string): string[] | null {
  const r = scan(s);
  if (!r) return null;
  const out: string[] = [];
  let last = 0;
  for (const c of r.commas) {
    out.push(s.slice(last, c).trim());
    last = c + 1;
  }
  const tail = s.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}

const width = (s: string) => {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 2 : 1;
  return w;
};

/** Wraps one line; returns the resulting lines. */
export function wrapLine(line: string, max = 100, unit = '  ', depth = 0): string[] {
  if (width(line) <= max || depth > 40) return [line];
  const trimmed = line.trim();
  if (/^(\/\/|\/\*|\*)/.test(trimmed)) return [line];
  const lead = /^\s*/.exec(line)![0];
  const r = scan(line);
  if (!r) return [line];

  for (const g of r.groups) {
    let { open, close } = g;
    let inner = line.slice(open + 1, close);
    let elems = splitTop(inner);
    if (!elems || !elems.length) continue;
    // Hug a single object/array argument: f({ … }) / f([ … ]) breaks the inner literal.
    while (elems.length === 1 && line[open] === '(') {
      const e = elems[0];
      const k = inner.indexOf(e);
      if (!(e[0] === '{' || e[0] === '[') || OPEN[e[0]] !== e[e.length - 1]) break;
      const sub = scan(e);
      if (!sub || sub.groups.length !== 1 || sub.groups[0].close !== e.length - 1) break;
      open = open + 1 + k;
      close = open + e.length - 1;
      inner = line.slice(open + 1, close);
      const next = splitTop(inner);
      if (!next) return [line];
      elems = next;
    }
    if (!elems.length) continue;
    const head = line.slice(0, open + 1).replace(/\s+$/, '');
    const tail = line.slice(close).replace(/^\s+/, '');
    const out = [head];
    elems.forEach((e, i) => {
      out.push(...wrapLine(lead + unit + e + (i < elems!.length - 1 ? ',' : ''), max, unit, depth + 1));
    });
    out.push(...wrapLine(lead + tail, max, unit, depth + 1));
    return out;
  }
  return [line];
}

/** Applies wrapLine to every line outside block comments and multi-line literals. */
export function wrapLongLines(text: string, max = 100, unit = '  '): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (inBlock) {
      out.push(line);
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    const t = line.trim();
    if (t.startsWith('/*') && !t.includes('*/')) {
      inBlock = true;
      out.push(line);
      continue;
    }
    out.push(...wrapLine(line, max, unit));
  }
  return out.join('\n');
}
