import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light';
const STORAGE_KEY = 'leve.theme.v1';

function readTheme(): Theme {
  try { return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({ theme: 'dark', setTheme: () => {} });

// Apply the stored preference before React mounts to avoid a dark flash.
document.documentElement.dataset.theme = readTheme();

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#181b20' : '#eef1f6');
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* The current session can still change themes. */ }
  }, [theme]);
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

export function terminalTheme(theme: Theme) {
  return theme === 'dark' ? {
    background: '#191d23', foreground: '#cbd3df', cursor: '#92b4f4', selectionBackground: '#344963',
    black: '#232831', red: '#e38d94', green: '#a4c89d', yellow: '#dfbd8c', blue: '#9ebfeb', magenta: '#c5a3e6', cyan: '#9fcac5', white: '#cbd3df',
    brightBlack: '#7c8d9f', brightRed: '#f0a1a7', brightGreen: '#bbdcb4', brightYellow: '#eed2a6', brightBlue: '#bad4f9', brightMagenta: '#dbbdf4', brightCyan: '#b7ded8', brightWhite: '#f0f4fa',
  } : {
    background: '#fafbfd', foreground: '#344054', cursor: '#285b9c', selectionBackground: '#cbdcf6',
    black: '#253044', red: '#b12836', green: '#28683b', yellow: '#815c0f', blue: '#285b9c', magenta: '#7b3da5', cyan: '#246f77', white: '#536178',
    brightBlack: '#69768a', brightRed: '#b83341', brightGreen: '#2b7441', brightYellow: '#8c6517', brightBlue: '#3069ae', brightMagenta: '#8946ad', brightCyan: '#287680', brightWhite: '#344054',
  };
}
