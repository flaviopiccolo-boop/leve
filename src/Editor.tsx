import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languageName, type OpenFile } from './workspace';

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#20242b', color: '#d4d9e2', fontSize: '13px' },
  '.cm-scroller': { fontFamily: '"Cascadia Code", Consolas, monospace', lineHeight: '1.8' },
  '.cm-content': { padding: '18px 0', caretColor: '#9bbcff' },
  '.cm-gutters': { backgroundColor: '#20242b', color: '#657080', border: 'none', minWidth: '54px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#272d36' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#354967' },
  '.cm-cursor': { borderLeftColor: '#a9c7ff' },
  '&.cm-focused': { outline: 'none' },
  '.cm-panels': { backgroundColor: '#252b34', color: '#d4d9e2' },
}, { dark: true });

const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: '#c5a3e6' },
  { tag: tags.string, color: '#a4c89d' },
  { tag: [tags.number, tags.bool, tags.null], color: '#dfbd8c' },
  { tag: tags.comment, color: '#7c8d9f', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#9ebfeb' },
  { tag: tags.typeName, color: '#9fcac5' },
  { tag: tags.propertyName, color: '#b0c8df' },
  { tag: tags.operator, color: '#a8b7ce' },
  { tag: tags.heading, color: '#b4cdf4', fontWeight: '600' },
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

export default function Editor({ file, onChange, onSave, onCursor }: {
  file: OpenFile; onChange: (path: string, value: string) => void;
  onSave: (path: string) => void; onCursor: (line: number, col: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
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
          basicSetup, theme, syntaxHighlighting(highlighting), language,
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
    });
    return () => { disposed = true; view?.destroy(); };
    // Preserve the editor and undo history as its document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);
  return <div className="editor-host" ref={host} />;
}
