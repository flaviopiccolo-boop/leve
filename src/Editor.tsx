import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languageName, type ContentMatch, type OpenFile } from './workspace';
import { useTheme, type Theme } from './theme';

const editorTheme = (mode: Theme) => EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--panel)', color: 'var(--text)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: '"Cascadia Code", Consolas, monospace', lineHeight: '1.8' },
  '.cm-content': { padding: '18px 0', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--gutter)', border: 'none', minWidth: '54px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--chrome)', color: 'var(--text)' },
}, { dark: mode === 'dark' });

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
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: /\.tsx?$/.test(path), jsx: /\.[jt]sx$/.test(path) });
    case 'JSON': return (await import('@codemirror/lang-json')).json();
    case 'Markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'CSS': return (await import('@codemirror/lang-css')).css();
    case 'HTML': return (await import('@codemirror/lang-html')).html();
    default: return [];
  }
}

export default function Editor({ file, jump, onJumpError, onChange, onSave, onCursor }: {
  file: OpenFile; onChange: (path: string, value: string) => void;
  jump?: (ContentMatch & { token: string }) | null; onJumpError?: () => void;
  onSave: (path: string) => void; onCursor: (line: number, col: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const themeRef = useRef(theme); themeRef.current = theme;
  const appearance = useRef(new Compartment());
  const editor = useRef<EditorView | undefined>(undefined);
  const jumpRef = useRef(jump); jumpRef.current = jump;
  const jumpError = useRef(onJumpError); jumpError.current = onJumpError;
  const appliedJump = useRef('');
  const applyJump = (view: EditorView) => {
    const target = jumpRef.current;
    if (!target || appliedJump.current === target.token) return;
    appliedJump.current = target.token;
    const doc = view.state.doc;
    if (target.line > doc.lines) { jumpError.current?.(); return; }
    const line = doc.line(target.line);
    const from = line.from + target.column - 1;
    const to = from + target.length;
    if (from > line.to || to > line.to || doc.sliceString(from, to) !== target.matchedText) { jumpError.current?.(); return; }
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    view.focus();
  };
  useEffect(() => { if (editor.current) applyJump(editor.current); }, [jump]);
  useEffect(() => {
    editor.current?.dispatch({ effects: appearance.current.reconfigure(editorTheme(theme)) });
  }, [theme]);
  const callbacks = useRef({ onChange, onSave, onCursor });
  callbacks.current = { onChange, onSave, onCursor };
  useEffect(() => {
    let disposed = false;
    let view: EditorView | undefined;
    void loadLanguage(file.path).then(language => {
      if (disposed || !host.current) return;
      view = new EditorView({
        parent: host.current,
        state: EditorState.create({ doc: file.content, extensions: [
          basicSetup, appearance.current.of(editorTheme(themeRef.current)), syntaxHighlighting(highlighting), language,
          keymap.of([{ key: 'Mod-s', run: () => { callbacks.current.onSave(file.path); return true; } }]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) callbacks.current.onChange(file.path, update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const pos = update.state.selection.main.head;
              const line = update.state.doc.lineAt(pos);
              callbacks.current.onCursor(line.number, pos - line.from + 1);
            }
          }),
        ] }),
      });
      editor.current = view;
      applyJump(view);
    });
    return () => { disposed = true; view?.destroy(); editor.current = undefined; };
    // Preserve the editor and undo history as its document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);
  return <div className="editor-host" ref={host} />;
}
