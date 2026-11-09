const storageKey = 'leve.editor.v1';
export const indentSizes = [2, 4, 8] as const;
export type IndentSize = (typeof indentSizes)[number];
export type IndentStyle = 'spaces' | 'tabs';

export interface EditorPreferences {
  useEditorConfig: boolean;
  indentSize: IndentSize;
  indentStyle: IndentStyle;
  indentGuides: 'off' | 'solid' | 'dotted';
  indentGuidePalette: 'neutral' | 'soft';
}

const defaults: EditorPreferences = { useEditorConfig: true, indentSize: 2, indentStyle: 'spaces', indentGuides: 'off', indentGuidePalette: 'neutral' };

export function loadEditorPreferences(): EditorPreferences {
  try {
    const saved: Partial<EditorPreferences> = JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? {};
    return {
      useEditorConfig: saved.useEditorConfig !== false,
      indentSize: indentSizes.find(size => size === saved.indentSize) ?? defaults.indentSize,
      indentStyle: saved.indentStyle === 'tabs' ? 'tabs' : defaults.indentStyle,
      indentGuides: saved.indentGuides === 'solid' || saved.indentGuides === 'dotted' ? saved.indentGuides : 'off',
      indentGuidePalette: saved.indentGuidePalette === 'soft' ? 'soft' : 'neutral',
    };
  } catch { return defaults; }
}

export function saveEditorPreferences(preferences: EditorPreferences) {
  try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
  catch { /* Keep applying changes in memory when storage is unavailable. */ }
}
