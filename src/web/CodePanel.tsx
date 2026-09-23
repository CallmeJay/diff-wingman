import { useEffect, useMemo, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import type { ReviewFile, Side, SourceRef } from '../shared/types.js';
import { buildDiffBlocks, type DiffLine } from './diff-lines.js';

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
}: {
  file: ReviewFile | null;
  activeRef: SourceRef | null;
  onLine: (side: Side, line: number) => void;
  diffLayout: 'side-by-side' | 'inline';
  showWhitespaceChanges: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const diffEditor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const editors = useRef<{
    before?: monaco.editor.IStandaloneCodeEditor;
    after?: monaco.editor.IStandaloneCodeEditor;
  }>({});
  const lineHandler = useRef(onLine);
  lineHandler.current = onLine;
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
    return () => {
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
    });
  }, [diffLayout, showWhitespaceChanges]);

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
}: {
  file: ReviewFile;
  diffLayout: 'side-by-side' | 'inline';
  showWhitespaceChanges: boolean;
  activeRef: SourceRef | null;
  onLine: (side: Side, line: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
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

  return (
    <div className={`static-diff ${diffLayout}`} data-testid="static-diff" ref={host}>
      {blocks.map((block, blockIndex) =>
        diffLayout === 'side-by-side' ? (
          Array.from({ length: Math.max(block.before.length, block.after.length) }, (_, index) => (
            <div className="static-diff-pair" key={`${blockIndex}-${index}`}>
              {renderLine('before', block.before[index], block.changed)}
              {renderLine('after', block.after[index], block.changed)}
            </div>
          ))
        ) : (
          <div key={blockIndex}>
            {block.changed && block.before.map((line) => <div key={`before-${line.number}`}>{renderLine('before', line, true)}</div>)}
            {block.after.map((line) => <div key={`after-${line.number}`}>{renderLine('after', line, block.changed)}</div>)}
          </div>
        ),
      )}
      {showWhitespaceChanges && (file.before ?? '').endsWith('\n') !== (file.after ?? '').endsWith('\n') && (
        <div className="static-diff-newline">
          文件末尾换行：修改前{(file.before ?? '').endsWith('\n') ? '有' : '无'}，修改后{(file.after ?? '').endsWith('\n') ? '有' : '无'}
        </div>
      )}
    </div>
  );
}
