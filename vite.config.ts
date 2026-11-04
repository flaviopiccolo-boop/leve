import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  optimizeDeps: { include: ['codemirror', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/highlight', '@codemirror/lang-python', '@codemirror/lang-javascript', '@codemirror/lang-json', '@codemirror/lang-css', '@codemirror/lang-html', '@codemirror/lang-markdown', '@xterm/xterm', '@xterm/addon-fit'] },
  build: { target: 'es2022' },
});
