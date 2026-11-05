import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

export const themePresets = {
  dark: { label: 'Dark', scheme: 'dark', description: 'Charcoal with soft blue accents' },
  light: { label: 'Light', scheme: 'light', description: 'White with cool blue accents' },
  midnight: { label: 'Midnight', scheme: 'dark', description: 'Deep navy and sky blue' },
  forest: { label: 'Forest', scheme: 'dark', description: 'Evergreen with mint accents' },
  paper: { label: 'Paper', scheme: 'light', description: 'Warm ivory and copper' },
} as const;
export type Theme = keyof typeof themePresets;
const STORAGE_KEY = 'leve.theme.v1';

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved && Object.hasOwn(themePresets, saved) ? saved as Theme : 'dark';
  }
  catch { return 'dark'; }
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({ theme: 'dark', setTheme: () => {} });

// Apply the stored preference before React mounts to avoid a dark flash.
document.documentElement.dataset.theme = readTheme();

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    const frame = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', frame);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* The current session can still change themes. */ }
  }, [theme]);
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

export function terminalTheme(theme: Theme) {
  const base = themePresets[theme].scheme === 'dark' ? {
    background: '#18191c', foreground: '#d6d7dc', cursor: '#a1c2ff', selectionBackground: '#344963',
    black: '#232831', red: '#e38d94', green: '#a4c89d', yellow: '#dfbd8c', blue: '#9ebfeb', magenta: '#c5a3e6', cyan: '#9fcac5', white: '#cbd3df',
    brightBlack: '#7c8d9f', brightRed: '#f0a1a7', brightGreen: '#bbdcb4', brightYellow: '#eed2a6', brightBlue: '#bad4f9', brightMagenta: '#dbbdf4', brightCyan: '#b7ded8', brightWhite: '#f0f4fa',
  } : {
    background: '#fcfdfe', foreground: '#30373d', cursor: '#285eaa', selectionBackground: '#cbdcf6',
    black: '#253044', red: '#b12836', green: '#28683b', yellow: '#815c0f', blue: '#285b9c', magenta: '#7b3da5', cyan: '#246f77', white: '#536178',
    brightBlack: '#69768a', brightRed: '#b83341', brightGreen: '#2b7441', brightYellow: '#8c6517', brightBlue: '#3069ae', brightMagenta: '#8946ad', brightCyan: '#287680', brightWhite: '#344054',
  };
  if (theme === 'dark' || theme === 'light') return base;

  // The terminal canvas needs actual color values. Read the active CSS palette after it is applied.
  const style = getComputedStyle(document.documentElement);
  const color = (token: string) => style.getPropertyValue(token).trim();
  return {
    ...base,
    background: color('--terminal'), foreground: color('--text'), cursor: color('--accent'),
    selectionBackground: color('--selection'),
    red: color('--error'), green: color('--syntax-string'), yellow: color('--syntax-number'),
    blue: color('--syntax-function'), magenta: color('--syntax-keyword'), cyan: color('--syntax-type'),
    white: color('--text'), brightBlack: color('--syntax-comment'), brightWhite: color('--strong'),
  };
}
