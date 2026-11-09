import { countColumn, type Range } from '@codemirror/state';
import { getIndentUnit } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

function visibleGuides(view: EditorView) {
  const { doc, tabSize } = view.state;
  const unit = getIndentUnit(view.state);
  const guides: Range<Decoration>[] = [];
  let lastLine = 0;
  for (const { from, to } of view.visibleRanges) {
    const start = Math.max(lastLine + 1, doc.lineAt(from).number);
    const end = doc.lineAt(to).number;
    for (let number = start; number <= end; number++) {
      const line = doc.line(number);
      const leading = /^[ \t]+/.exec(line.text)?.[0];
      if (!leading) continue;
      const width = Math.floor(countColumn(leading, tabSize) / unit) * unit;
      if (!width) continue;
      guides.push(Decoration.line({ attributes: {
        class: 'cm-indent-guides',
        style: `--indent-guide-step: ${unit}ch; --indent-guide-width: ${width}ch;`,
      } }).range(line.from));
    }
    lastLine = end;
  }
  return Decoration.set(guides);
}

export const editorIndentGuides = ViewPlugin.fromClass(class {
  decorations;
  constructor(view: EditorView) { this.decorations = visibleGuides(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize || getIndentUnit(update.startState) !== getIndentUnit(update.state)) {
      this.decorations = visibleGuides(update.view);
    }
  }
}, { decorations: plugin => plugin.decorations });
