import { useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalSquare, Play } from 'lucide-react';
import { native } from './workspace';

export default function Terminal({ id, root }: { id: string; root: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!running || !native || !host.current) return;
    let disposed = false;
    let started = false;
    const pendingInput: string[] = [];
    const terminal = new XTerminal({ cursorBlink: true, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, theme: { background: '#191d23', foreground: '#cbd3df', cursor: '#92b4f4', selectionBackground: '#344963' }, scrollback: 3000 });
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
    void invoke('terminal_start', { id, cols: terminal.cols, rows: terminal.rows, output }).then(() => {
      started = true;
      if (disposed) void invoke('terminal_close', { id }).catch(() => {});
      else {
        // ConPTY may ask for the cursor position before the start command resolves.
        for (const data of pendingInput) void invoke('terminal_write', { id, data }).catch(err => setError(String(err)));
        pendingInput.length = 0;
        terminal.focus();
      }
    }).catch(err => { if (!disposed) setError(String(err)); });
    return () => {
      disposed = true;
      observer.disconnect(); input.dispose(); terminal.dispose();
      if (started) void invoke('terminal_close', { id }).catch(() => {});
    };
  }, [running, id]);

  if (!running) return <div className="terminal-start">
    <TerminalSquare size={24} strokeWidth={1.3} />
    <div><strong>Seu projeto. Seu terminal.</strong><p>{native ? 'Abra uma sessão do PowerShell na pasta do projeto.' : 'O PowerShell integrado estará disponível no aplicativo Windows.'}</p></div>
    <button className="button" disabled={!native || !root} onClick={() => setRunning(true)}><Play size={13} /> Iniciar PowerShell</button>
    {!native && <span className="subtle">Prévia web · nenhum comando é executado aqui</span>}
    {native && !root && <span className="subtle">Abra uma pasta para iniciar.</span>}
  </div>;
  return <div className="terminal-shell"><div ref={host} className="terminal-host" />{error && <div role="alert" className="terminal-error">{error}</div>}</div>;
}
