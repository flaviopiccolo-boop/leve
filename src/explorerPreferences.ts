const storageKey = 'leve.explorer.v1';

export const explorerIconStyles = {
  standard: 'Standard',
  colorful: 'Colorful',
  monochrome: 'Monochrome',
  none: 'No icons',
} as const;

export interface ExplorerPreferences {
  icons: keyof typeof explorerIconStyles;
  density: 'comfortable' | 'compact';
  indentGuides: boolean;
  foldersFirst: boolean;
  gitIndicators: boolean;
}

const defaults: ExplorerPreferences = {
  icons: 'standard', density: 'comfortable', indentGuides: false, foldersFirst: true, gitIndicators: true,
};

export function loadExplorerPreferences(): ExplorerPreferences {
  try {
    const saved: Partial<ExplorerPreferences> = JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? {};
    return {
      icons: typeof saved.icons === 'string' && Object.hasOwn(explorerIconStyles, saved.icons) ? saved.icons : defaults.icons,
      density: saved.density === 'compact' ? 'compact' : defaults.density,
      indentGuides: saved.indentGuides === true,
      foldersFirst: saved.foldersFirst !== false,
      gitIndicators: saved.gitIndicators !== false,
    };
  } catch { return defaults; }
}

export function saveExplorerPreferences(preferences: ExplorerPreferences) {
  try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
  catch { /* Keep applying changes in memory when storage is unavailable. */ }
}
