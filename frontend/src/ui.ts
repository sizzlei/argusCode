// Small DOM helpers: element builder, modal dialogs, context menu, toasts.

type Attrs = Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c as any);
  return el;
}

// ---- Modal -----------------------------------------------------------------

interface ModalButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

let modalOpen = false;
export const isModalOpen = () => modalOpen;

/** Shows a message with buttons; resolves to the chosen value ("" on Esc). */
export function ask(title: string, message: string, buttons: ModalButton[]): Promise<string> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const close = (v: string) => {
      modalOpen = false;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(v);
    };
    const btns = buttons.map((b) =>
      h(
        'button',
        {
          class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
          onclick: () => close(b.value),
        },
        b.label,
      ),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close('');
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const p = buttons.find((b) => b.primary) ?? buttons[0];
        close(p.value);
      }
    };
    const overlay = h(
      'div',
      { class: 'modal-overlay' },
      h(
        'div',
        { class: 'modal', role: 'dialog' },
        h('div', { class: 'modal-title' }, title),
        h('div', { class: 'modal-body' }, message),
        h('div', { class: 'modal-actions' }, ...btns),
      ),
    );
    modalOpen = true;
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    (btns.find((_, i) => buttons[i].primary) ?? btns[0])?.focus();
  });
}

/** Asks for a single line of text. Resolves to null when cancelled. */
export function prompt(title: string, initial = '', selectUntilDot = false): Promise<string | null> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const input = h('input', { class: 'input', value: initial, spellcheck: 'false' });
    const close = (v: string | null) => {
      modalOpen = false;
      overlay.remove();
      prevFocus?.focus?.();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // Korean IME composition in progress
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = input.value.trim();
        close(v || null);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      }
      e.stopPropagation();
    });
    const overlay = h(
      'div',
      {
        class: 'modal-overlay',
        onmousedown: (e: MouseEvent) => {
          if (e.target === overlay) close(null);
        },
      },
      h('div', { class: 'modal modal-prompt' }, h('div', { class: 'modal-title' }, title), input),
    );
    modalOpen = true;
    document.body.append(overlay);
    input.focus();
    const dot = initial.lastIndexOf('.');
    if (selectUntilDot && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}

// ---- Context menu ----------------------------------------------------------

export interface MenuItem {
  label: string;
  hint?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

let menuEl: HTMLElement | null = null;
export function closeContextMenu() {
  menuEl?.remove();
  menuEl = null;
}

export function contextMenu(x: number, y: number, items: MenuItem[]) {
  closeContextMenu();
  const el = h(
    'div',
    { class: 'ctx-menu' },
    ...items.map((it) =>
      it.separator
        ? h('div', { class: 'ctx-sep' })
        : h(
            'div',
            {
              class: 'ctx-item' + (it.disabled ? ' disabled' : ''),
              onmousedown: (e: MouseEvent) => e.preventDefault(),
              onclick: () => {
                closeContextMenu();
                if (!it.disabled) it.action?.();
              },
            },
            h('span', {}, it.label),
            it.hint ? h('span', { class: 'ctx-hint' }, it.hint) : null,
          ),
    ),
  );
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  el.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  menuEl = el;
}

document.addEventListener('mousedown', (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeContextMenu();
});
window.addEventListener('blur', closeContextMenu);

// ---- Toasts ----------------------------------------------------------------

export function toast(
  message: string,
  kind: 'info' | 'error' = 'info',
  actions: { label: string; run: () => void }[] = [],
  timeout = actions.length ? 0 : 3500,
) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts' });
    document.body.append(host);
  }
  const close = () => el.remove();
  const el = h(
    'div',
    { class: 'toast ' + kind },
    h('span', { class: 'toast-msg' }, message),
    ...actions.map((a) =>
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            close();
            a.run();
          },
        },
        a.label,
      ),
    ),
    h('button', { class: 'toast-x', title: 'Dismiss', onclick: close }, '×'),
  );
  host.append(el);
  if (timeout) setTimeout(close, timeout);
  return close;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
