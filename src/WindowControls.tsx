import { useEffect, useRef, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import type { Window } from '@tauri-apps/api/window';

export default function WindowControls({ report }: { report: (message: string) => void }) {
  const windowRef = useRef<Window | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      if (!active) return;
      const window = getCurrentWindow();
      windowRef.current = window;
      const refresh = async () => {
        const value = await window.isMaximized();
        if (active) setMaximized(value === true);
      };
      await refresh();
      const dispose = await window.onResized(() => { void refresh().catch(() => {}); });
      if (active) unlisten = dispose;
      else dispose();
    }).catch(error => { if (active) report(`Could not read window state: ${String(error)}`); });
    return () => {
      active = false;
      windowRef.current = null;
      unlisten?.();
    };
  }, [report]);

  const control = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    const window = windowRef.current;
    if (!window) return;
    void window[action]().then(async () => {
      if (action === 'toggleMaximize' && windowRef.current === window) setMaximized(await window.isMaximized());
    }).catch(error => report(`Window command failed: ${String(error)}`));
  };

  const maximizeLabel = maximized ? 'Restore window' : 'Maximize window';
  return <div className="window-controls" data-tauri-drag-region="false">
    <button className="window-control" title="Minimize window" aria-label="Minimize window" onClick={() => control('minimize')}><Minus size={15} /></button>
    <button className="window-control" title={maximizeLabel} aria-label={maximizeLabel} onClick={() => control('toggleMaximize')}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
    <button className="window-control window-close" title="Close window" aria-label="Close window" onClick={() => control('close')}><X size={16} /></button>
  </div>;
}
