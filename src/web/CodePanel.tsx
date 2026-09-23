import { useEffect, useMemo, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import type { ReviewFile, Side, SourceRef } from '../shared/types.js';
import { buildDiffBlocks, type DiffLine } from './diff-lines.js';

export type DiffJump = { side: Side; line: number; token: number };

(self as typeof self & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

function language(filePath: string): string {
  if (/\.[cm]?tsx?$/.test(filePath)) return 'typescript';
  if (/\.[cm]?jsx?$/.test(filePath)) return 'javascript';
  if (/\.s?css$/.test(filePath)) return 'css';
  if (/\.md$/.test(filePath)) return 'markdown';
  return 'plaintext';
}

export function CodePanel({
  file,
  activeRef,
  onLine,
  diffLayout,
  showWhitespaceChanges,
  showFullFile,
  jump,
  onPosition,
}: {
  file: ReviewFile | null;
  activeRef: SourceRef | null;
  onLine: (side: Side, line: number) => void;
  diffLayout: 'side-by-side' | 'inline';
  showWhitespaceChanges: boolean;
  showFullFile: boolean;
  jump: DiffJump | null;
  onPosition: (side: Side, line: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const diffEditor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const editors = useRef<{
    before?: monaco.editor.IStandaloneCodeEditor;
    after?: monaco.editor.IStandaloneCodeEditor;
  }>({});
  const lineHandler = useRef(onLine);
  lineHandler.current = onLine;
  const positionHandler = useRef(onPosition);
  positionHandler.current = onPosition;
  const suppressScroll = useRef(false);
  const userScrollUntil = useRef(0);
  const related = !file && activeRef;

  useEffect(() => {
    if (!host.current || (!file && !related)) return;
    if (file?.issue) return;
    const options: monaco.editor.IStandaloneEditorConstructionOptions = {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      lineHeight: 21,
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 16 },
      folding: true,
      lineNumbersMinChars: 3,
      glyphMargin: false,
    };
    if (related) {
      const model = monaco.editor.createModel(related.code, language(related.path));
      const editor = monaco.editor.create(host.current, {
        ...options,
        model,
        lineNumbers: (number) => String(number + related.startLine - 1),
        ariaLabel: '相关源码片段',
      });
      editors.current = { [related.side]: editor };
      return () => {
        editor.dispose();
        model.dispose();
        editors.current = {};
      };
    }
    const before = monaco.editor.createModel(file!.before ?? '', language(file!.oldPath));
    const after = monaco.editor.createModel(file!.after ?? '', language(file!.path));
    const editor = monaco.editor.createDiffEditor(host.current, {
      ...options,
      originalEditable: false,
      renderSideBySide: diffLayout === 'side-by-side',
      enableSplitViewResizing: true,
      useInlineViewWhenSpaceIsLimited: false,
      ignoreTrimWhitespace: !showWhitespaceChanges,
      hideUnchangedRegions: {
        enabled: !showFullFile,
        contextLineCount: 3,
        revealLineCount: 20,
        minimumLineCount: 3,
      },
      originalAriaLabel: '修改前源码',
      modifiedAriaLabel: '修改后源码',
    });
    diffEditor.current = editor;
    editor.setModel({ original: before, modified: after });
    editors.current = { before: editor.getOriginalEditor(), after: editor.getModifiedEditor() };
    const subscriptions = (['before', 'after'] as const).map((side) =>
      editors.current[side]!.onMouseDown((event) => {
        if (event.target.position) lineHandler.current(side, event.target.position.lineNumber);
      }),
    );
    // 只把人工滚动记录为阅读位置；Monaco 异步计算 diff 时也会改变 scrollTop。
    const markUserScroll = () => { userScrollUntil.current = Date.now() + 750; };
    const onEditorKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) markUserScroll();
    };
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('.scrollbar')) markUserScroll();
    };
    host.current.addEventListener('wheel', markUserScroll, { passive: true });
    host.current.addEventListener('touchmove', markUserScroll, { passive: true });
    host.current.addEventListener('keydown', onEditorKey);
    host.current.addEventListener('pointerdown', onPointerDown);
    subscriptions.push(editor.getModifiedEditor().onDidScrollChange((event) => {
      if (!event.scrollTopChanged || suppressScroll.current || Date.now() > userScrollUntil.current) return;
      const first = editor.getModifiedEditor().getVisibleRanges()[0]?.startLineNumber;
      if (first) positionHandler.current('after', first);
    }));
    return () => {
      host.current?.removeEventListener('wheel', markUserScroll);
      host.current?.removeEventListener('touchmove', markUserScroll);
      host.current?.removeEventListener('keydown', onEditorKey);
      host.current?.removeEventListener('pointerdown', onPointerDown);
      subscriptions.forEach((item) => item.dispose());
      editor.dispose();
      diffEditor.current = null;
      before.dispose();
      after.dispose();
      editors.current = {};
    };
  }, [file, related]);

  // 视图设置只更新 Monaco 选项，避免重建模型导致当前引用和滚动位置丢失。
  useEffect(() => {
    diffEditor.current?.updateOptions({
      renderSideBySide: diffLayout === 'side-by-side',
      ignoreTrimWhitespace: !showWhitespaceChanges,
      hideUnchangedRegions: { enabled: !showFullFile, contextLineCount: 3, revealLineCount: 20, minimumLineCount: 3 },
    });
  }, [diffLayout, showWhitespaceChanges, showFullFile]);

  useEffect(() => {
    if (!file || !jump) return;
    const editor = editors.current[jump.side];
    suppressScroll.current = true;
    userScrollUntil.current = 0;
    editor?.revealLineNearTop(jump.line);
    const frame = requestAnimationFrame(() => { suppressScroll.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [file, jump?.token]);

  useEffect(() => {
    if (!activeRef || !file) return;
    const editor = editors.current[activeRef.side];
    if (!editor) return;
    editor.setSelection(new monaco.Range(activeRef.startLine, 1, activeRef.endLine, 1000));
    editor.revealLineInCenter(activeRef.startLine);
  }, [activeRef, file]);

  if (file?.issue)
    return (
      <div className="code-unavailable">
        <span className="large-symbol">◇</span>
        <h3>此文件保留在变更清单中</h3>
        <p>{file.issue}</p>
        <p className="mono">
          {file.oldMode} → {file.newMode}
        </p>
      </div>
    );
  return <div className="editor-host" ref={host} data-testid="code-editor" />;
}

export function StaticDiffPanel({
  file,
  diffLayout,
  showWhitespaceChanges,
  activeRef,
  onLine,
  showFullFile,
  jump,
  onPosition,
}: {
  file: ReviewFile;
  diffLayout: 'side-by-side' | 'inline';
  showWhitespaceChanges: boolean;
  activeRef: SourceRef | null;
  onLine: (side: Side, line: number) => void;
  showFullFile: boolean;
  jump: DiffJump | null;
  onPosition: (side: Side, line: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const suppressScroll = useRef(false);
  const userScrollUntil = useRef(0);
  const [expanded, setExpanded] = useState<Record<string, { top: number; bottom: number }>>({});
  const blocks = useMemo(
    () => buildDiffBlocks(file.before ?? '', file.after ?? '', showWhitespaceChanges),
    [file, showWhitespaceChanges],
  );

  useEffect(() => {
    if (!activeRef) return;
    host.current
      ?.querySelector<HTMLElement>(`[data-side="${activeRef.side}"][data-line="${activeRef.startLine}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [activeRef, file, diffLayout, showWhitespaceChanges]);

  useEffect(() => {
    setExpanded({});
  }, [file.id, showWhitespaceChanges]);

  useEffect(() => {
    if (!jump) return;
    suppressScroll.current = true;
    userScrollUntil.current = 0;
    host.current
      ?.querySelector<HTMLElement>(`[data-side="${jump.side}"][data-line="${jump.line}"]`)
      ?.scrollIntoView({ block: 'start' });
    const frame = requestAnimationFrame(() => { suppressScroll.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [jump?.token, file, diffLayout, showWhitespaceChanges, expanded]);

  const renderLine = (side: Side, line: DiffLine | undefined, changed: boolean) =>
    line ? (
      <button
        type="button"
        className={`static-diff-line${changed ? side === 'before' ? ' removed' : ' added' : ''}`}
        aria-label={`${side === 'before' ? '修改前' : '修改后'}第 ${line.number} 行`}
        aria-current={activeRef?.side === side && line.number >= activeRef.startLine && line.number <= activeRef.endLine ? 'location' : undefined}
        data-side={side}
        data-line={line.number}
        onClick={() => onLine(side, line.number)}
      >
        <span>{line.number}</span><code>{line.text.replace(/\r$/, '') || ' '}</code>
      </button>
    ) : <div className="static-diff-line empty" />;

  const renderRows = (block: typeof blocks[number], blockIndex: number, start: number, end: number) =>
    diffLayout === 'side-by-side' ?
      Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return <div className="static-diff-pair" key={`${blockIndex}-${index}`}>
          {renderLine('before', block.before[index], block.changed)}
          {renderLine('after', block.after[index], block.changed)}
        </div>;
      }) :
      <div key={`${blockIndex}-${start}`}>
        {block.changed && block.before.slice(start, end).map((line) => <div key={`before-${line.number}`}>{renderLine('before', line, true)}</div>)}
        {block.after.slice(start, end).map((line) => <div key={`after-${line.number}`}>{renderLine('after', line, block.changed)}</div>)}
      </div>;

  const renderedHunks = new Set<string>();
  const renderBlock = (block: typeof blocks[number], blockIndex: number) => {
    const count = Math.max(block.before.length, block.after.length);
    const overlaps = (start: number, length: number, lines: DiffLine[]) =>
      length > 0 && lines.length > 0 && lines[0].number < start + length && lines.at(-1)!.number >= start;
    const hunks = file.changes.filter((item) => item.id.includes(':hunk-'));
    const change = hunks.find((item) => (
      overlaps(item.oldStart, item.oldLines, block.before) || overlaps(item.newStart, item.newLines, block.after)
    ));
    if (block.changed) {
      const first = change && !renderedHunks.has(change.id);
      if (change) renderedHunks.add(change.id);
      return <div key={blockIndex} data-hunk-id={first ? change.id : undefined}>
        {first && <div className="static-diff-hunk">{change.label}</div>}
        {renderRows(block, blockIndex, 0, count)}
      </div>;
    }
    if (showFullFile || hunks.length === 0) return <div key={blockIndex}>{renderRows(block, blockIndex, 0, count)}</div>;

    // 以快照的 Git hunk 范围决定可见行；空白变更被忽略高亮时也不能被折叠隐藏。
    const windows = hunks.flatMap((item) => {
      const side = block.before.length ? block.before : block.after;
      const startLine = block.before.length ? item.oldStart : item.newStart;
      const length = block.before.length ? item.oldLines : item.newLines;
      if (!overlaps(startLine, length, side)) return [];
      return [{
        start: Math.max(0, startLine - side[0].number),
        end: Math.min(count, startLine + length - side[0].number),
        item,
      }];
    }).sort((left, right) => left.start - right.start);
    const renderGap = (start: number, end: number, gapIndex: number) => {
      if (end <= start) return null;
      if (end - start <= 3) return renderRows(block, blockIndex, start, end);
      const key = `${blockIndex}:${gapIndex}`;
      const extra = expanded[key] ?? { top: 0, bottom: 0 };
      const top = Math.min(end - start, extra.top);
      const bottom = Math.min(end - start - top, extra.bottom);
      if (top + bottom >= end - start) return renderRows(block, blockIndex, start, end);
      return <div key={key}>
        {renderRows(block, blockIndex, start, start + top)}
        <div className="static-diff-fold">
          <span>折叠 {end - start - top - bottom} 行未修改代码</span>
          <button type="button" onClick={() => setExpanded((value) => ({ ...value, [key]: { ...extra, bottom: extra.bottom + 20 } }))}>向上扩展 20 行</button>
          <button type="button" onClick={() => setExpanded((value) => ({ ...value, [key]: { ...extra, top: extra.top + 20 } }))}>向下扩展 20 行</button>
          <button type="button" onClick={() => setExpanded((value) => ({ ...value, [key]: { top: end - start, bottom: 0 } }))}>展开此段</button>
        </div>
        {renderRows(block, blockIndex, end - bottom, end)}
      </div>;
    };
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    for (const [index, window] of windows.entries()) {
      parts.push(renderGap(cursor, window.start, index));
      if (!renderedHunks.has(window.item.id)) {
        renderedHunks.add(window.item.id);
        parts.push(<div key={`hunk-${window.item.id}`} className="static-diff-hunk" data-hunk-id={window.item.id}>{window.item.label}</div>);
      }
      parts.push(renderRows(block, blockIndex, window.start, window.end));
      cursor = window.end;
    }
    parts.push(renderGap(cursor, count, windows.length));
    return <div key={blockIndex}>{parts}</div>;
  };

  return (
    <div className={`static-diff ${diffLayout}`} data-testid="static-diff" ref={host}
      onWheel={() => { userScrollUntil.current = Date.now() + 750; }}
      onTouchMove={() => { userScrollUntil.current = Date.now() + 750; }}
      onKeyDown={(event) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) userScrollUntil.current = Date.now() + 750; }}
      onScroll={() => {
        if (suppressScroll.current || Date.now() > userScrollUntil.current) return;
        const root = host.current;
        if (!root) return;
        const element = document.elementFromPoint(root.getBoundingClientRect().left + 45, root.getBoundingClientRect().top + 24);
        const row = element?.closest<HTMLElement>('[data-side][data-line]');
        if (row && root.contains(row)) onPosition(row.dataset.side as Side, Number(row.dataset.line));
      }}>
      {blocks.map(renderBlock)}
      {showWhitespaceChanges && (file.before ?? '').endsWith('\n') !== (file.after ?? '').endsWith('\n') && (
        <div className="static-diff-newline">
          文件末尾换行：修改前{(file.before ?? '').endsWith('\n') ? '有' : '无'}，修改后{(file.after ?? '').endsWith('\n') ? '有' : '无'}
        </div>
      )}
    </div>
  );
}
