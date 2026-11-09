const bom = '\uFEFF';

export type TextEncoding = 'UTF-8' | 'UTF-8 with BOM';

export function textEncoding(content: string): TextEncoding {
  return content.startsWith(bom) ? 'UTF-8 with BOM' : 'UTF-8';
}

export function stripBom(content: string): string {
  return content.startsWith(bom) ? content.slice(1) : content;
}

export function encodeEditorText(text: string, encoding: TextEncoding): string {
  // A leading U+FEFF in the text needs its own signature to round-trip as text.
  return encoding === 'UTF-8 with BOM' || text.startsWith(bom) ? bom + text : text;
}

export function convertEncoding(content: string, encoding: TextEncoding): string | null {
  if (textEncoding(content) === encoding) return content;
  const text = stripBom(content);
  if (encoding === 'UTF-8' && text.startsWith(bom)) return null;
  return encodeEditorText(text, encoding);
}
