import { useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { native } from './workspace';
import { terminalTheme, useTheme } from './theme';

export default function Terminal({ id, shellId = 'powershell' }: { id: string; shellId?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const themeRef = useRef(theme); themeRef.current = theme;
  const instance = useRef<XTerminal | undefined>(undefined);
  useEffect(() => { if (instance.current) instance.current.options.theme = terminalTheme(theme); }, [theme]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let started = false;
    const pendingInput: string[] = [];
    const terminal = new XTerminal({ cursorBlink: true, disableStdin: !native, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, theme: terminalTheme(themeRef.current), scrollback: 3000 });
    instance.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    const observer = new ResizeObserver(() => {
      if (!host.current?.clientWidth || !host.current.clientHeight) return;
      fit.fit();
      if (started) void invoke('terminal_resize', { id, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
    });
    observer.observe(host.current);
    if (!native) {
      terminal.writeln('Browser preview — local shell commands cannot run here.');
      terminal.writeln('Open the Leve desktop app to use this terminal.');
      return () => { disposed = true; observer.disconnect(); terminal.dispose(); instance.current = undefined; };
    }
    setError('');
    const output = new Channel<number[]>();
    output.onmessage = bytes => { if (!disposed) terminal.write(new Uint8Array(bytes)); };
    const input = terminal.onData(data => {
      if (started) void invoke('terminal_write', { id, data }).catch(err => { if (!disposed) setError(String(err)); });
      else pendingInput.push(data);
    });
    void invoke('terminal_start', { id, shellId, cols: terminal.cols, rows: terminal.rows, output }).then(() => {
      started = true;
      if (disposed) void invoke('terminal_close', { id }).catch(() => {});
      else {
        // ConPTY may ask for the cursor position before the start command resolves.
        for (const data of pendingInput) void invoke('terminal_write', { id, data }).catch(err => setError(String(err)));
        pendingInput.length = 0;
        terminal.focus();
      }
    }).catch(err => { if (!disposed) setError(`Could not start terminal: ${String(err)}. Close this tab and choose a shell with + to try again.`); });
    return () => {
      disposed = true;
      observer.disconnect(); input.dispose(); terminal.dispose(); instance.current = undefined;
      if (started) void invoke('terminal_close', { id }).catch(() => {});
    };
  }, [id, shellId]);

  return <div className="terminal-shell"><div ref={host} className="terminal-host" />{error && <div role="alert" className="terminal-error">{error}</div>}</div>;
}
