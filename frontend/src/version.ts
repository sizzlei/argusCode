// Version comparison (no imports, unit-tested with plain Node).

/** "0.10.0" > "0.9.1"; a leading "v" and pre-release suffixes are ignored. */
export function isNewer(a: string, b: string): boolean {
  const p = (v: string) =>
    v
      .trim()
      .replace(/^v/, '')
      .split(/[-+ ]/)[0]
      .split('.')
      .map((x) => parseInt(x, 10) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
