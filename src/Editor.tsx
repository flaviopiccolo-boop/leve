import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { basicSetup } from 'codemirror';
import { indentWithTab, isolateHistory } from '@codemirror/commands';
import { Compartment, countColumn, EditorState, type ChangeSet, type ChangeSpec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { forEachDiagnostic, lintGutter, nextDiagnostic, setDiagnosticsEffect } from '@codemirror/lint';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languageName, type OpenFile } from './workspace';
import type { EditorPreferences, IndentStyle } from './editorPreferences';
import { editorIndentGuides } from './editorIndentGuides';
import { stripBom } from './textEncoding';
import { languageError, languageFeature, languageFeatures, languageId, type Definition, type LanguageWorkspace, type Problem } from './language';
import { themePresets, useTheme, type Theme } from './theme';

const editorTheme = (mode: Theme) => EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--panel)', color: 'var(--text)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: '"Cascadia Code", Consolas, monospace', lineHeight: '1.8' },
  '.cm-content': { padding: '18px 0', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--gutter)', border: 'none', minWidth: '54px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--active-line) 40%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-editor .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '&.cm-editor.cm-focused > .cm-scroller > .cm-layer.cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 38%, var(--selection))',
  },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--chrome)', color: 'var(--text)' },
}, { dark: themePresets[mode].scheme === 'dark' });

const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: 'var(--syntax-function)' },
  { tag: tags.typeName, color: 'var(--syntax-type)' },
  { tag: tags.propertyName, color: 'var(--syntax-property)' },
  { tag: tags.operator, color: 'var(--text)' },
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '600' },
]);

async function loadLanguage(path: string) {
  switch (languageName(path)) {
    case 'Python': return (await import('@codemirror/lang-python')).python();
    case 'TypeScript': case 'TSX': case 'JavaScript': case 'JSX':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: languageId(path).startsWith('typescript'), jsx: /\.[jt]sx$/i.test(path) });
    case 'JSON': return (await import('@codemirror/lang-json')).json();
    case 'Markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'CSS': return (await import('@codemirror/lang-css')).css();
    case 'HTML': return (await import('@codemirror/lang-html')).html();
    default: return [];
  }
}

export type EditorJump = { path: string; line: number; column: number; token: string; length?: number; matchedText?: string };

export interface EditorHandle {
  convertIndentation(style: IndentStyle): void;
}

function indentationSettings(size: number, style: IndentStyle, tabWidth: number) {
  const unit = style === 'tabs' ? '\t'.repeat(size / tabWidth) : ' '.repeat(size);
  return [EditorState.tabSize.of(tabWidth), indentUnit.of(unit)];
}

function indentationChanges(state: EditorState, style: IndentStyle): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let from = 0;
  for (const line of state.doc.iterLines()) {
    const leading = /^[ \t]+/.exec(line)?.[0];
    if (leading) {
      const columns = countColumn(leading, state.tabSize);
      const insert = style === 'spaces' ? ' '.repeat(columns)
        : '\t'.repeat(Math.floor(columns / state.tabSize)) + ' '.repeat(columns % state.tabSize);
      if (insert !== leading) changes.push({ from, to: from + leading.length, insert });
    }
    from += line.length + 1;
  }
  return changes;
}

export default function Editor({ ref, file, jump, active, preferences, languageWorkspace, lspEnabled, lintEnabled, onProblems, onDefinition, onLanguageError, onJumpError, onChange, onSave, onSaveAs, onCursor }: {
  ref?: Ref<EditorHandle>;
  file: OpenFile; onChange: (path: string, changes: ChangeSet) => void;
  preferences: Omit<EditorPreferences, 'indentSize'> & { indentSize: number; tabWidth: number };
  jump?: EditorJump | null; onJumpError?: () => void;
  languageWorkspace: LanguageWorkspace | null;
  active: boolean; lspEnabled: boolean; lintEnabled: boolean;
  onProblems: (path: string, problems: Problem[]) => void;
  onDefinition: (definition: Definition) => Promise<void>;
  onLanguageError: (message: string) => void;
  onSave: (path: string) => void; onSaveAs: (path: string) => void; onCursor: (line: number, col: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const themeRef = useRef(theme); themeRef.current = theme;
  const appearance = useRef(new Compartment());
  const indentation = useRef(new Compartment());
  const indentGuides = useRef(new Compartment());
  const intelligence = useRef(new Compartment());
  const diagnostics = useRef(new Compartment());
  const editor = useRef<EditorView | undefined>(undefined);
  const [ready, setReady] = useState<EditorView | null>(null);
  const { indentSize, indentStyle, tabWidth } = preferences;
  useImperativeHandle(ref, () => ({
    convertIndentation(style) {
      const view = editor.current;
      if (!view) return;
      const changes = indentationChanges(view.state, style);
      if (changes.length) view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input.indent' });
      requestAnimationFrame(() => { if (editor.current === view) view.focus(); });
    },
  }), []);
  const id = languageId(file.path);
  const languageCallbacks = useRef({ onDefinition, onLanguageError, onProblems, languageWorkspace, lspEnabled });
  languageCallbacks.current = { onDefinition, onLanguageError, onProblems, languageWorkspace, lspEnabled };
  const lastLintError = useRef('');
  const documentError = useRef('');
  const lintResultView = useRef<EditorView | null>(null);
  const jumpRef = useRef(jump); jumpRef.current = jump;
  const jumpError = useRef(onJumpError); jumpError.current = onJumpError;
  const appliedJump = useRef('');
  const applyJump = (view: EditorView) => {
    const target = jumpRef.current;
    if (!target || appliedJump.current === target.token) return;
    appliedJump.current = target.token;
    const doc = view.state.doc;
    if (target.matchedText !== undefined && target.line > doc.lines) { jumpError.current?.(); return; }
    const line = doc.line(Math.min(target.line, doc.lines));
    const from = line.from + Math.min(target.column - 1, line.length);
    const to = from + (target.length ?? 0);
    if (target.matchedText !== undefined && (to > line.to || doc.sliceString(from, to) !== target.matchedText)) { jumpError.current?.(); return; }
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    view.focus();
  };
  useEffect(() => { if (editor.current) applyJump(editor.current); }, [jump]);
  useEffect(() => {
    editor.current?.dispatch({ effects: appearance.current.reconfigure(editorTheme(theme)) });
  }, [theme]);
  const showIndentGuides = preferences.indentGuides !== 'off';
  useEffect(() => {
    if (ready && editor.current === ready) ready.dispatch({ effects: indentation.current.reconfigure(indentationSettings(indentSize, indentStyle, tabWidth)) });
  }, [ready, indentSize, indentStyle, tabWidth]);
  useEffect(() => {
    if (ready && editor.current === ready) ready.dispatch({ effects: indentGuides.current.reconfigure(showIndentGuides ? editorIndentGuides : []) });
  }, [ready, showIndentGuides]);
  useEffect(() => {
    if (!ready || editor.current !== ready) return;
    ready.dispatch({ effects: diagnostics.current.reconfigure(lspEnabled || lintEnabled ? [lintGutter(), keymap.of([{ key: 'F8', run: nextDiagnostic }])] : []) });
  }, [ready, lspEnabled, lintEnabled]);
  useEffect(() => {
    if (!ready || editor.current !== ready || !languageWorkspace || !lspEnabled || !id) return;
    let attached = true;
    const compartment = intelligence.current;
    documentError.current = '';
    void languageWorkspace.document(file.path, id).then(plugin => {
      if (attached && plugin) ready.dispatch({ effects: compartment.reconfigure(plugin) });
    }).catch(error => {
      if (attached) documentError.current = languageError(error);
    });
    return () => {
      attached = false;
      if (editor.current === ready) {
        ready.dispatch({ effects: compartment.reconfigure([]) });
        void import('./lspClient').then(({ clearDiagnostics }) => {
          if (editor.current === ready && (!languageCallbacks.current.lspEnabled || languageCallbacks.current.languageWorkspace !== languageWorkspace)) clearDiagnostics(ready, 'Language server');
        });
      }
    };
  }, [ready, languageWorkspace, file.path, id, lspEnabled]);
  useEffect(() => {
    if (!ready || editor.current !== ready || !languageWorkspace || !lintEnabled || !active) return;
    const doc = ready.state.doc;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const messages = await languageWorkspace.lint(file.path, doc.toString(), controller.signal);
        const { displayEslint } = await import('./lspClient');
        if (controller.signal.aborted || ready.state.doc !== doc) return;
        lastLintError.current = '';
        lintResultView.current = ready;
        displayEslint(ready, messages);
      } catch (error) {
        if (controller.signal.aborted || ready.state.doc !== doc) return;
        const message = languageError(error);
        if (lastLintError.current !== message) languageCallbacks.current.onLanguageError(message);
        lastLintError.current = message;
      }
    }, 750);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [ready, languageWorkspace, file.path, file.content, lintEnabled, active]);
  useEffect(() => {
    if (!ready || editor.current !== ready || lintEnabled || lintResultView.current !== ready) return;
    let current = true;
    lastLintError.current = '';
    // Remove only ESLint's markers so language-server diagnostics remain visible.
    void import('./lspClient').then(({ clearDiagnostics }) => {
      if (current && editor.current === ready) {
        lintResultView.current = null;
        clearDiagnostics(ready, 'ESLint');
      }
    });
    return () => { current = false; };
  }, [ready, lintEnabled]);
  const callbacks = useRef({ onChange, onSave, onCursor });
  callbacks.current = { onChange, onSave, onCursor };
  useEffect(() => {
    let disposed = false;
    let view: EditorView | undefined;
    void loadLanguage(file.path).then(language => {
      if (disposed || !host.current) return;
      view = new EditorView({
        parent: host.current,
        state: EditorState.create({ doc: stripBom(file.content), extensions: [
          basicSetup, appearance.current.of(editorTheme(themeRef.current)), indentation.current.of(indentationSettings(indentSize, indentStyle, tabWidth)), indentGuides.current.of([]), intelligence.current.of([]), diagnostics.current.of([]), syntaxHighlighting(highlighting), language,
          keymap.of([
            indentWithTab,
            { key: 'Mod-s', stopPropagation: true, run: () => { callbacks.current.onSave(file.path); return true; } },
            { key: 'F12', run: currentView => {
              const { languageWorkspace, lspEnabled, onDefinition, onLanguageError } = languageCallbacks.current;
              const feature = languageFeature(id);
              if (!feature) onLanguageError('Go to Definition is unavailable for this file type.');
              else if (!lspEnabled || !languageWorkspace) onLanguageError(`Enable ${languageFeatures[feature]} in Settings → Language support to use Go to Definition.`);
              else void import('./lspClient').then(({ requestDefinition }) => {
                if (editor.current !== currentView || !languageCallbacks.current.lspEnabled) return;
                const reason = languageWorkspace.errorFor(id) || documentError.current || `Starting ${languageFeatures[feature]} language support…`;
                requestDefinition(currentView, onDefinition, onLanguageError, reason);
              });
              return true;
            } },
          ]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) callbacks.current.onChange(file.path, update.changes);
            if (update.docChanged || update.transactions.some(tr => tr.effects.some(effect => effect.is(setDiagnosticsEffect)))) {
              const problems: Problem[] = [];
              forEachDiagnostic(update.state, (diagnostic, from) => {
                const line = update.state.doc.lineAt(from);
                problems.push({ path: file.path, line: line.number, column: from - line.from + 1,
                  severity: diagnostic.severity, message: diagnostic.message, source: diagnostic.source });
              });
              languageCallbacks.current.onProblems(file.path, problems);
            }
            if (update.selectionSet || update.docChanged) {
              const pos = update.state.selection.main.head;
              const line = update.state.doc.lineAt(pos);
              callbacks.current.onCursor(line.number, pos - line.from + 1);
            }
          }),
        ] }),
      });
      editor.current = view;
      setReady(view);
      applyJump(view);
    });
    return () => {
      disposed = true;
      view?.destroy();
      editor.current = undefined;
      languageCallbacks.current.onProblems(file.path, []);
    };
    // Preserve the editor and undo history as its document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);
  return <div className="editor-host" ref={host} data-indent-guides={preferences.indentGuides} data-indent-guide-palette={preferences.indentGuidePalette} onKeyDownCapture={event => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    event.stopPropagation();
    onSaveAs(file.path);
  }} />;
}
