// Deadlock viewer — rendered into the same side panel as the execution plan
// (⌥⌘E / Ctrl+Alt+E) when the document contains a deadlock report.

import { DB_LABEL, Deadlock, DlLock, DlTxn } from './deadlock';

export interface DeadlockViewHooks {
  /** Jump to a 0-based line in the source document. */
  jump(line: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const TXN_COLORS = 4;

export function renderDeadlockView(host: HTMLElement, list: Deadlock[], hooks: DeadlockViewHooks) {
  host.className = 'plan-view dl-view';
  const scroll = host.scrollTop;
  const parts: HTMLElement[] = [];
  list.forEach((d, k) => parts.push(report(d, k, list.length, hooks)));
  host.replaceChildren(...parts);
  host.scrollTop = scroll;
}

function jumpable(node: HTMLElement, line: number, hooks: DeadlockViewHooks) {
  if (line < 0) return;
  node.classList.add('jump');
  node.title = `${line + 1}번째 줄로 이동`;
  node.addEventListener('click', (e) => {
    if (window.getSelection()?.toString()) return; // allow copying text
    e.stopPropagation();
    hooks.jump(line);
  });
}

function txnChip(t: DlTxn, idx: number): HTMLElement {
  return el('span', `dl-txn c${idx % TXN_COLORS}`, t.name);
}

function report(d: Deadlock, k: number, total: number, hooks: DeadlockViewHooks): HTMLElement {
  const box = el('section', 'dl-report');

  // Header
  const h = el('div', 'plan-head');
  const title = el('div', 'plan-title');
  title.append(el('span', 'plan-engine', DB_LABEL[d.db] + ' 데드락'));
  if (d.time) title.append(el('span', 'plan-tag', d.time));
  if (total > 1) title.append(el('span', 'plan-tag', `${k + 1} / ${total}`));
  jumpable(title, d.line, hooks);
  h.append(title);
  const stats = el('div', 'plan-stats');
  const stat = (label: string, value: string) => {
    const s = el('span', 'plan-stat');
    s.append(el('span', 'plan-stat-label', label), el('b', '', value));
    stats.append(s);
  };
  stat(d.db === 'oracle' ? '세션' : d.db === 'postgresql' ? '프로세스' : '트랜잭션', String(d.txns.length));
  const victim = d.txns.find((t) => t.victim);
  if (victim) stat(d.db === 'oracle' ? '문장 롤백' : '롤백', victim.name);
  h.append(stats);
  box.append(h);

  const body = el('div', 'dl-body');
  if (d.victimNote) body.append(el('div', 'dl-victim', d.victimNote));

  // Wait-for cycle
  if (d.edges.length) {
    const sec = el('div', 'dl-sec');
    const h4 = el('h4', '', '대기 관계');
    h4.append(el('span', 'dl-sub', 'A → B : A가 B의 락을 기다림'));
    sec.append(h4);
    const cyc = el('div', 'dl-cycle');
    const order = cycleOrder(d);
    order.forEach((i, n) => {
      if (n) cyc.append(el('span', 'dl-arrow', '→'));
      cyc.append(txnChip(d.txns[i], i));
    });
    sec.append(cyc);
    for (const e of d.edges) {
      const row = el('div', 'dl-edge');
      const what = el('span', 'dl-edge-lock');
      if (e.lock) {
        what.append(modeChip(e.lock), el('span', 'dl-target', e.lock.target));
        const key = e.lock.details.find((x) => !/^로그에|^상대 트랜잭션/.test(x));
        if (key) what.append(el('span', 'dl-key', key));
      }
      row.append(txnChip(d.txns[e.from], e.from), el('span', 'dl-arrow', '→'), txnChip(d.txns[e.to], e.to), what);
      jumpable(row, e.lock?.line ?? -1, hooks);
      sec.append(row);
    }
    body.append(sec);
  }

  // Hints
  if (d.hints.length) {
    const sec = el('div', 'dl-sec');
    sec.append(el('h4', '', '원인 분석'));
    const ul = el('ul', 'dl-hints');
    for (const t of d.hints) ul.append(el('li', '', t));
    sec.append(ul);
    body.append(sec);
  }

  // Transactions
  const cards = el('div', 'dl-cards');
  d.txns.forEach((t, i) => cards.append(card(d, t, i, hooks)));
  body.append(cards);
  box.append(body);
  return box;
}

/** Transactions in wait-for order, starting from the first, closing the cycle. */
function cycleOrder(d: Deadlock): number[] {
  const next = new Map<number, number>();
  for (const e of d.edges) if (!next.has(e.from)) next.set(e.from, e.to);
  const out = [0];
  const seen = new Set([0]);
  let cur = 0;
  while (next.has(cur)) {
    cur = next.get(cur)!;
    out.push(cur);
    if (seen.has(cur)) break;
    seen.add(cur);
  }
  return out.length > 1 ? out : d.txns.map((_, i) => i);
}

function modeChip(l: DlLock): HTMLElement {
  const f = l.flags;
  const cls = f.has('ii')
    ? 'ii'
    : f.has('gap') || f.has('next') || f.has('supremum')
      ? 'gap'
      : f.has('table')
        ? 'tbl'
        : f.has('S')
          ? 's'
          : 'x';
  return el('span', 'dl-mode m-' + cls, l.mode);
}

function lockRow(l: DlLock, hooks: DeadlockViewHooks): HTMLElement {
  const r = el('div', 'dl-lock' + (l.inferred ? ' inferred' : ''));
  const top = el('div', 'dl-lock-top');
  top.append(modeChip(l), el('span', 'dl-target', l.target));
  r.append(top);
  const shown = l.details.slice(0, 5);
  for (const x of shown) r.append(el('div', 'dl-detail', x));
  if (l.details.length > shown.length) r.append(el('div', 'dl-detail', `… 외 ${l.details.length - shown.length}개`));
  jumpable(r, l.line, hooks);
  return r;
}

function card(d: Deadlock, t: DlTxn, i: number, hooks: DeadlockViewHooks): HTMLElement {
  const c = el('div', 'dl-card' + (t.victim ? ' victim' : ''));
  const head = el('div', 'dl-card-head');
  head.append(txnChip(t, i));
  if (t.victim) head.append(el('span', 'dl-badge', d.db === 'oracle' ? '문장 롤백' : '롤백됨'));
  jumpable(head, t.line, hooks);
  c.append(head);

  if (t.meta.length) {
    const meta = el('div', 'dl-meta');
    for (const [k, v] of t.meta) meta.append(el('span', 'dl-meta-k', k), el('span', 'dl-meta-v', v));
    c.append(meta);
  }
  if (t.sql) {
    const pre = el('pre', 'dl-sql', t.sql.trim());
    jumpable(pre, t.sqlLine, hooks);
    c.append(pre);
  }
  const group = (label: string, locks: DlLock[], cls: string) => {
    if (!locks.length) return;
    const g = el('div', 'dl-locks ' + cls);
    g.append(el('div', 'dl-locks-label', label));
    for (const l of locks) g.append(lockRow(l, hooks));
    c.append(g);
  };
  group('보유한 락', t.holds, 'holds');
  group('기다리는 락', t.waits, 'waits');
  return c;
}
