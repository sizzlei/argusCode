// Korean right-click menu for the editor (replaces the WebView's native,
// English-only menu).

import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { undo, redo, undoDepth, redoDepth, toggleComment, selectAll } from '@codemirror/commands';
import { openSearchPanel, gotoLine } from '@codemirror/search';
import { copyText, isMac, readText } from './backend';
import { canFormat, LangId } from './languages';
import { contextMenu, MenuItem, toast } from './ui';
import { convertToInList, goToDefinition, resolveAt, selectStatement } from './sqltools';
import { shortcut } from './keybindings';

export interface EditorMenuHooks {
  langOf(view: EditorView): LangId | null;
  run(cmd: string): void;
}

const k = (mac: string, win: string) => (isMac ? mac : win);

function selectedText(view: EditorView): string {
  const { state } = view;
  return state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join(state.lineBreak);
}

function changeCase(view: EditorView, upper: boolean) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      if (r.empty) return { range: r };
      const text = state.sliceDoc(r.from, r.to);
      const insert = upper ? text.toUpperCase() : text.toLowerCase();
      return {
        changes: { from: r.from, to: r.to, insert },
        range: EditorSelection.range(r.from, r.from + insert.length),
      };
    }),
  );
}

/** Shows the menu for a right-click at (x, y) inside `view`. */
export function showEditorMenu(view: EditorView, e: MouseEvent, hooks: EditorMenuHooks) {
  // Move the cursor to the click unless it is inside the current selection.
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos != null && !view.state.selection.ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to)) {
    view.dispatch({ selection: { anchor: pos } });
  }
  view.focus();

  const state = view.state;
  const hasSel = state.selection.ranges.some((r) => !r.empty);
  const lang = hooks.langOf(view);
  const sel = selectedText(view);

  const items: MenuItem[] = [
    { label: '실행 취소', hint: k('⌘Z', 'Ctrl+Z'), disabled: undoDepth(state) === 0, action: () => undo(view) },
    { label: '다시 실행', hint: k('⇧⌘Z', 'Ctrl+Y'), disabled: redoDepth(state) === 0, action: () => redo(view) },
    { separator: true, label: '' },
    {
      label: '잘라내기',
      hint: k('⌘X', 'Ctrl+X'),
      disabled: !hasSel,
      action: async () => {
        await copyText(sel);
        view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut' });
      },
    },
    { label: '복사', hint: k('⌘C', 'Ctrl+C'), disabled: !hasSel, action: () => copyText(sel) },
    {
      label: '붙여넣기',
      hint: k('⌘V', 'Ctrl+V'),
      action: async () => {
        try {
          const text = await readText();
          if (text)
            view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
        } catch {
          toast('클립보드를 읽을 수 없습니다. ' + k('⌘V', 'Ctrl+V') + '를 사용해 주세요.', 'error');
        }
      },
    },
    { label: '모두 선택', hint: k('⌘A', 'Ctrl+A'), action: () => selectAll(view) },
    { separator: true, label: '' },
    { label: '주석 토글', hint: k('⌘/', 'Ctrl+/'), action: () => toggleComment(view) },
    { label: '대문자로 변환', disabled: !hasSel, action: () => changeCase(view, true) },
    { label: '소문자로 변환', disabled: !hasSel, action: () => changeCase(view, false) },
  ];
  if (lang && canFormat(lang)) {
    items.push({
      label: hasSel ? '선택 영역 정렬' : '문서 정렬',
      hint: shortcut('format'),
      action: () => hooks.run('format'),
    });
  }
  if (lang === 'sql') {
    const def = resolveAt(state, state.selection.main.head);
    items.push(
      { separator: true, label: '' },
      {
        label: def
          ? `정의로 이동 (${def.column ? def.table.name + '.' + def.column.name : def.table.name})`
          : '정의로 이동',
        hint: 'F12',
        disabled: !def,
        action: () => goToDefinition(view),
      },
      { label: '현재 문장 선택', hint: k('⇧⌘A', 'Ctrl+Shift+A'), action: () => selectStatement(view) },
    );
  }
  if (lang === 'sql' || lang === 'text') {
    items.push({
      label: hasSel ? '선택 영역을 IN 목록으로 변환' : '문서를 IN 목록으로 변환',
      action: () => convertToInList(view),
    });
  }
  if (lang === 'json' || lang === 'yaml') {
    items.push(
      { separator: true, label: '' },
      lang === 'json'
        ? { label: 'YAML로 변환 (새 탭)', hint: shortcut('data.convert'), action: () => hooks.run('data.convert') }
        : { label: 'JSON으로 변환 (새 탭)', hint: shortcut('data.convert'), action: () => hooks.run('data.convert') },
      { label: '키 이름순 정렬', hint: shortcut('data.sortKeys'), action: () => hooks.run('data.sortKeys') },
    );
    if (lang === 'json')
      items.push({ label: '한 줄로 압축', hint: shortcut('data.minify'), action: () => hooks.run('data.minify') });
  }
  items.push(
    { separator: true, label: '' },
    { label: '찾기 / 바꾸기', hint: k('⌘F', 'Ctrl+F'), action: () => openSearchPanel(view) },
    { label: '줄로 이동…', hint: k('⌥⌘G', 'Ctrl+Alt+G'), action: () => gotoLine(view) },
    { label: '폴더에서 찾기', hint: shortcut('view.search'), action: () => hooks.run('view.search') },
    { separator: true, label: '' },
    { label: '오른쪽으로 분할', hint: shortcut('pane.split'), action: () => hooks.run('pane.split') },
  );
  if (lang === 'json' || lang === 'text' || lang === 'sql' || lang === 'javascript') {
    items.push({
      label: '실행계획 / 데드락 보기',
      hint: shortcut('plan.toggle'),
      action: () => hooks.run('plan.toggle'),
    });
  }
  // Shown for any document that contains a command document (log lines are
  // often pasted into the default SQL tab or a .log file).
  if (
    /"(find|aggregate|count|distinct|insert|update|delete|findAndModify|findandmodify|command)"\s*:/.test(
      state.sliceDoc(0, 20000),
    )
  ) {
    items.push({
      label: hasSel ? '선택 영역을 mongosh 쿼리로 변환 (새 탭)' : 'mongosh 쿼리로 변환 (새 탭)',
      hint: shortcut('mongo.toShell'),
      action: () => hooks.run('mongo.toShell'),
    });
  }
  items.push(
    { label: '저장된 버전과 비교', hint: shortcut('diff.saved'), action: () => hooks.run('diff.saved') },
    { label: '다른 탭과 비교…', hint: shortcut('diff.tabs'), action: () => hooks.run('diff.tabs') },
  );
  if (lang === 'markdown') {
    items.push({ label: 'Markdown 미리보기', hint: shortcut('md.preview'), action: () => hooks.run('md.preview') });
  }
  contextMenu(e.clientX, e.clientY, items);
}
