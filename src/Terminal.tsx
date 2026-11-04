import { useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalSquare, Play } from 'lucide-react';
import { native } from './workspace';
import { terminalTheme, useTheme } from './theme';
import type { ShellProfile } from './shells';

export default function Terminal({ id, root, shellId = 'powershell', autoStart = false, profiles, onShellChange }: {
  id: string; root: string | null; shellId?: string; autoStart?: boolean;
  profiles: ShellProfile[]; onShellChange: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const themeRef = useRef(theme); themeRef.current = theme;
  const instance = useRef<XTerminal | undefined>(undefined);
  useEffect(() => { if (instance.current) instance.current.options.theme = terminalTheme(theme); }, [theme]);
  const [running, setRunning] = useState(() => autoStart && native && !!root);
  const [error, setError] = useState('');
  const profile = profiles.find(item => item.id === shellId);
  useEffect(() => {
    if (!running || !native || !host.current) return;
    let disposed = false;
    let started = false;
    const pendingInput: string[] = [];
    const terminal = new XTerminal({ cursorBlink: true, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, theme: terminalTheme(themeRef.current), scrollback: 3000 });
    instance.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    const output = new Channel<number[]>();
    output.onmessage = bytes => { if (!disposed) terminal.write(new Uint8Array(bytes)); };
    const input = terminal.onData(data => {
      if (started) void invoke('terminal_write', { id, data }).catch(err => setError(String(err)));
      else pendingInput.push(data);
    });
    const observer = new ResizeObserver(() => {
      if (!host.current?.clientWidth || !host.current.clientHeight) return;
      fit.fit();
      if (started) void invoke('terminal_resize', { id, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
    });
    observer.observe(host.current);
    void invoke('terminal_start', { id, shellId, cols: terminal.cols, rows: terminal.rows, output }).then(() => {
      started = true;
      if (disposed) void invoke('terminal_close', { id }).catch(() => {});
      else {
        // ConPTY may ask for the cursor position before the start command resolves.
        for (const data of pendingInput) void invoke('terminal_write', { id, data }).catch(err => setError(String(err)));
        pendingInput.length = 0;
        terminal.focus();
      }
    }).catch(err => { if (!disposed) { setError(String(err)); setRunning(false); } });
    return () => {
      disposed = true;
      observer.disconnect(); input.dispose(); terminal.dispose(); instance.current = undefined;
      if (started) void invoke('terminal_close', { id }).catch(() => {});
    };
  }, [running, id, shellId]);

  if (!running) return <div className="terminal-start">
    <TerminalSquare size={24} strokeWidth={1.3} />
    <div><strong>Your project. Your terminal.</strong><p>{native ? 'Open a shell session in your project folder.' : 'Integrated terminals are available in the Windows app.'}</p></div>
    <div className="terminal-launch"><select aria-label="Terminal profile" value={shellId} onChange={event => onShellChange(event.target.value)} disabled={!profiles.length}>
      {!profiles.length && <option value={shellId}>Detecting shells…</option>}
      {profiles.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}{item.available ? '' : ' — Not installed'}</option>)}
    </select><button className="button" disabled={!native || !root || !profile?.available} onClick={() => { setError(''); setRunning(true); }}><Play size={13} /> Start {profile?.name || 'terminal'}</button></div>
    {error && <span className="inline-error" role="alert">{error}</span>}
    {!native && <span className="subtle">Web preview · no commands run here</span>}
    {native && !root && <span className="subtle">Open a folder to get started.</span>}
  </div>;
  return <div className="terminal-shell"><div ref={host} className="terminal-host" />{error && <div role="alert" className="terminal-error">{error}</div>}</div>;
}
