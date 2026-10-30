// Self-update: checks GitHub Releases, downloads and installs the new version
// (Go side, internal/update), restarts, and shows the release notes once
// after an update.

import { api, onEvent, openUrl, ReleaseInfo, UpdateInfo } from './backend';
import { errText, h, setModalOpen, toast } from './ui';
export { isNewer } from './version';

export interface UpdateHooks {
  /** Asks about unsaved files and saves the session; false = cancelled. */
  prepareQuit(): Promise<boolean>;
}

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
let busy = false;
let installed: ReleaseInfo | null = null;
let hooks: UpdateHooks;
let progressEl: HTMLElement | null = null;

export function initUpdates(h: UpdateHooks) {
  hooks = h;
  onEvent('update:progress', (done: number, total: number) => showProgress(done, total));
}

/**
 * Checks for a newer release. Automatic checks are silent unless an update is
 * found; manual ones always report the result.
 */
export async function checkForUpdates(manual: boolean, last?: { at: number; save(at: number): void }) {
  if (installed) return readyToast(installed);
  if (busy) return manual ? toast('업데이트를 확인하는 중입니다…') : undefined;
  if (!manual && last && Date.now() - last.at < CHECK_INTERVAL) return;
  busy = true;
  let info: UpdateInfo;
  try {
    info = await api.CheckUpdate(__APP_VERSION__);
    last?.save(Date.now());
  } catch (e) {
    if (manual) toast(errText(e), 'error');
    return;
  } finally {
    busy = false;
  }
  const r = info.release;
  if (!info.available) {
    if (manual) toast(`최신 버전입니다 (v${__APP_VERSION__}).`);
    return;
  }
  const actions = [
    { label: '릴리스 노트', run: () => void showReleaseNotes(r, false) },
    info.supported
      ? { label: '지금 업데이트', run: () => void install(r) }
      : { label: '내려받기 페이지', run: () => openUrl(r.url) },
  ];
  toast(`새 버전 v${r.version}이 있습니다 (현재 v${__APP_VERSION__}).`, 'info', actions);
}

async function install(r: ReleaseInfo) {
  if (busy) return;
  busy = true;
  showProgress(0, r.assetSize);
  try {
    await api.InstallUpdate(r.tag);
    installed = r;
    hideProgress();
    readyToast(r);
  } catch (e) {
    hideProgress();
    toast(`업데이트 실패: ${errText(e)}`, 'error', [{ label: '내려받기 페이지', run: () => openUrl(r.url) }]);
  } finally {
    busy = false;
  }
}

function readyToast(r: ReleaseInfo) {
  toast(`v${r.version}을 설치했습니다. 다시 시작하면 적용됩니다.`, 'info', [
    { label: '다시 시작', run: () => void restart() },
  ]);
}

async function restart() {
  if (!(await hooks.prepareQuit())) {
    if (installed) readyToast(installed);
    return;
  }
  try {
    await api.RestartApp();
  } catch (e) {
    toast(errText(e), 'error');
  }
}

// ---- progress -------------------------------------------------------------------------

function showProgress(done: number, total: number) {
  if (!busy && !progressEl) return;
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts' });
    document.body.append(host);
  }
  if (!progressEl) {
    progressEl = h(
      'div',
      { class: 'toast update-progress' },
      h('span', { class: 'toast-msg' }, '업데이트 내려받는 중…'),
      h('div', { class: 'update-bar' }, h('div', { class: 'update-bar-fill' })),
    );
    host.append(progressEl);
  }
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const mb = (n: number) => (n / 1048576).toFixed(1);
  (progressEl.querySelector('.toast-msg') as HTMLElement).textContent =
    done >= total && total > 0 ? '설치하는 중…' : `업데이트 내려받는 중… ${mb(done)} / ${mb(total)} MB`;
  (progressEl.querySelector('.update-bar-fill') as HTMLElement).style.width = pct + '%';
}

function hideProgress() {
  progressEl?.remove();
  progressEl = null;
}

// ---- release notes ------------------------------------------------------------------

/**
 * Shows the notes of a release (object or tag). `afterUpdate` changes the
 * title to "업데이트되었습니다".
 */
export async function showReleaseNotes(release: ReleaseInfo | string, afterUpdate: boolean) {
  let r: ReleaseInfo | null = typeof release === 'string' ? null : release;
  const tag = typeof release === 'string' ? release : release.tag;
  let error = '';
  if (!r) {
    try {
      r = await api.ReleaseNotes(tag);
    } catch (e) {
      error = errText(e);
    }
  }
  const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]);
  const body = h('div', { class: 'release-notes markdown-body' });
  const html = r?.notes?.trim()
    ? await marked.parse(r.notes, { gfm: true, breaks: false })
    : (r?.notesHtml?.trim() ?? '');
  if (html) {
    body.innerHTML = DOMPurify.sanitize(html);
    for (const a of body.querySelectorAll('a')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const href = a.getAttribute('href');
        if (href && /^https?:/.test(href)) openUrl(href);
      });
    }
  } else {
    body.append(
      h('p', { class: 'muted' }, error ? `릴리스 노트를 불러오지 못했습니다: ${error}` : '릴리스 노트가 없습니다.'),
    );
  }
  const version = r?.version ?? tag.replace(/^v/, '');
  const title = afterUpdate ? `v${version}으로 업데이트되었습니다` : `ArgusCode v${version}`;
  const url = r?.url || `https://github.com/sizzlei/argusCode/releases/tag/${tag}`;

  const prevFocus = document.activeElement as HTMLElement | null;
  const close = () => {
    setModalOpen(false);
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const ok = h('button', { class: 'btn primary', onclick: close }, '확인');
  const overlay = h(
    'div',
    { class: 'modal-overlay' },
    h(
      'div',
      { class: 'modal release-modal', role: 'dialog', 'aria-label': title },
      h(
        'div',
        { class: 'modal-title' },
        title,
        r?.name && r.name !== tag ? h('span', { class: 'release-sub' }, r.name) : null,
      ),
      body,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => openUrl(url) }, 'GitHub에서 보기 ↗'),
        ok,
      ),
    ),
  );
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  setModalOpen(true);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  ok.focus();
}
