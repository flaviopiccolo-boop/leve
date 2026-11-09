import type { ChangeSet } from '@codemirror/state';
import { encodeEditorText, stripBom, textEncoding } from './textEncoding';

const separators = { LF: '\n', CRLF: '\r\n', CR: '\r' } as const;
export type LineEnding = keyof typeof separators;

function endingOf(separator: string): LineEnding {
  return separator === '\r\n' ? 'CRLF' : separator === '\r' ? 'CR' : 'LF';
}

export function preferredLineEnding(content: string): LineEnding {
  return endingOf(/\r\n?|\n/.exec(content)?.[0] ?? '\n');
}

export function lineEndingLabel(content: string, fallback: LineEnding = 'LF'): LineEnding | 'Mixed' {
  const first = /\r\n?|\n/.exec(content)?.[0];
  if (!first) return fallback;
  if (first === '\r\n' ? /(^|[^\r])\n|\r(?!\n)/.test(content) : content.includes(first === '\n' ? '\r' : '\n')) return 'Mixed';
  return endingOf(first);
}

export function convertLineEndings(content: string, ending: LineEnding): string {
  return content.replace(/\r\n?|\n/g, separators[ending]);
}

export function applyTextChanges(content: string, changes: ChangeSet, ending: LineEnding): string {
  const body = stripBom(content);
  // CodeMirror uses one character per line break. In the saved text, CRLF uses two.
  let nextCRLF = body.indexOf('\r\n');
  let extra = 0;
  const rawOffset = (position: number) => {
    while (nextCRLF >= 0 && nextCRLF - extra < position) {
      extra++;
      nextCRLF = body.indexOf('\r\n', nextCRLF + 2);
    }
    return position + extra;
  };
  const parts: string[] = [];
  const append = (part: string) => {
    if (!part) return;
    // Keep two breaks distinct if an edit joins a lone CR to an LF.
    if (parts.at(-1)?.endsWith('\r') && part.startsWith('\n')) parts.push('\n');
    parts.push(part);
  };
  let cursor = 0;
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    const start = rawOffset(from);
    append(body.slice(cursor, start));
    append(inserted.sliceString(0, inserted.length, separators[ending]));
    cursor = rawOffset(to);
  });
  append(body.slice(cursor));
  return encodeEditorText(parts.join(''), textEncoding(content));
}
