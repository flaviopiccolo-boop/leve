import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2, FilePlus2, Folder, FolderOpen, FolderPlus, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import { fileName, listFiles, native, type FileEntry, type FileOperation } from './workspace';

function Tree({ path = '', depth = 0, refresh, reveal, onOpen, onMenu }: { path?: string; depth?: number; refresh: number; reveal: string; onOpen: (path: string) => void; onMenu: (entry: FileEntry, x: number, y: number) => void }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState(new Set(['src']));
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    void listFiles(path).then(items => { if (active) setEntries(items); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [path, refresh]);
  useEffect(() => {
    if (reveal) setExpanded(previous => {
      const next = new Set(previous);
      reveal.split('/').forEach((_, index, parts) => next.add(parts.slice(0, index + 1).join('/')));
      return next;
    });
  }, [reveal]);
  return <>{error && <p className="inline-error">{error}</p>}{entries.map(entry => <div key={entry.path}>
    <div className="tree-row" onContextMenu={event => { event.preventDefault(); onMenu(entry, event.clientX, event.clientY); }}>
      <button className="tree-item" style={{ paddingLeft: 12 + depth * 15 }} title={entry.path} aria-expanded={entry.directory ? expanded.has(entry.path) : undefined} onClick={() => {
        if (!entry.directory) onOpen(entry.path);
        else setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
      }}>
        {entry.directory ? <>{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={15} className="folder-icon" /></> : <><span className="tree-spacer" /><FileCode2 size={14} className={entry.name.endsWith('.py') ? 'python-icon' : 'file-icon'} /></>}
        <span>{entry.name}</span>
      </button>
      <button className="icon-button tree-more" aria-label={`Actions for ${entry.path}`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onMenu(entry, rect.left, rect.bottom); }}><MoreHorizontal size={14} /></button>
    </div>
    {entry.directory && expanded.has(entry.path) && <Tree path={entry.path} depth={depth + 1} refresh={refresh} reveal={reveal} onOpen={onOpen} onMenu={onMenu} />}
  </div>)}</>;
}

export default function Explorer({ root, blocked, refresh, reveal, onRefresh, onOpen, onFolder, onOperation }: { root: string | null; blocked: boolean; refresh: number; reveal: string; onRefresh: () => void; onOpen: (path: string) => void; onFolder: () => void; onOperation: (operation: FileOperation) => void }) {
  const [menu, setMenu] = useState<{ entry: FileEntry; left: number; top: number } | null>(null);
  const enabled = !blocked && (!native || !!root);
  const action = (operation: FileOperation) => { setMenu(null); onOperation(operation); };
  return <div className="explorer panel-scroll">
    <div className="panel-heading"><span>PROJECT FOLDER</span><div>
      <button className="icon-button" title="New file" disabled={!enabled} onClick={() => action({ kind: 'file', parent: '' })}><FilePlus2 size={14} /></button>
      <button className="icon-button" title="New folder" disabled={!enabled} onClick={() => action({ kind: 'folder', parent: '' })}><FolderPlus size={14} /></button>
      <button className="icon-button" title="Refresh files" onClick={onRefresh}><RefreshCw size={13} /></button>
      <button className="icon-button" title="Open folder" onClick={onFolder}><FolderOpen size={15} /></button>
    </div></div>
    <div className="project-heading"><ChevronDown size={13} /><span>{root ? fileName(root) : 'example-project'}</span>{!root && <span className="demo-badge">DEMO</span>}</div>
    {blocked ? <p className="panel-description">Project unavailable. Recovered files remain open.</p> : <Tree key={root ?? 'demo'} refresh={refresh} reveal={reveal} onOpen={onOpen} onMenu={(entry, x, y) => { if (enabled) setMenu({ entry, left: Math.max(8, Math.min(x, window.innerWidth - 210)), top: Math.max(8, Math.min(y, window.innerHeight - 200)) }); }} />}
    <button className="open-folder-link" onClick={onFolder}><FolderOpen size={14} /> Open another folder</button>
    {menu && <div className="terminal-menu-backdrop" onClick={() => setMenu(null)} onKeyDown={event => { if (event.key === 'Escape') setMenu(null); if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button')); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); } }}>
      <div className="terminal-menu file-menu" role="menu" aria-label={`Actions for ${menu.entry.name}`} style={{ left: menu.left, top: menu.top }} onClick={event => event.stopPropagation()}>
        {menu.entry.directory && <><button role="menuitem" onClick={() => action({ kind: 'file', parent: menu.entry.path })}>New file…</button><button role="menuitem" onClick={() => action({ kind: 'folder', parent: menu.entry.path })}>New folder…</button></>}
        <button autoFocus role="menuitem" onClick={() => action({ kind: 'rename', entry: menu.entry })}>Rename…</button>
        <button role="menuitem" onClick={() => action({ kind: 'delete', entry: menu.entry })}>Delete…</button>
      </div>
    </div>}
  </div>;
}

export function FileDialog({ operation, dirtyCount, busy, error, onCancel, onSubmit }: { operation: FileOperation; dirtyCount: number; busy: boolean; error: string; onCancel: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(operation.kind === 'rename' ? operation.entry.name : '');
  const deleting = operation.kind === 'delete';
  const title = deleting ? 'Delete permanently' : operation.kind === 'rename' ? 'Rename' : operation.kind === 'folder' ? 'New folder' : 'New file';
  return <div className="modal-backdrop" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button:not(:disabled), input:not(:disabled)'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      else if (!controls.length) event.preventDefault();
    }
  }}>
    <form className="settings-modal file-dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={event => { event.preventDefault(); if (!busy) onSubmit(name); }}>
      <div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Cancel file operation" disabled={busy} onClick={onCancel}><X size={18} /></button></div>
      <p className="file-path">{'entry' in operation ? operation.entry.path : operation.parent || 'Project root'}</p>
      {deleting ? <p>This permanently deletes this {operation.entry.directory ? 'folder and all its contents' : 'file'} from disk. This cannot be undone.{dirtyCount > 0 && ` ${dirtyCount} open file(s) have unsaved changes that will also be discarded.`}</p> : <label className="file-name-label">Name<input autoFocus required maxLength={240} value={name} disabled={busy} onFocus={event => event.target.select()} onChange={event => setName(event.target.value)} /></label>}
      {operation.kind === 'rename' && dirtyCount > 0 && <p>Unsaved edits will be kept under the new name.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="file-dialog-actions"><button type="button" autoFocus={deleting} className="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy || (!deleting && !name.trim())}>{busy ? 'Working…' : deleting ? 'Delete permanently' : operation.kind === 'rename' ? 'Rename' : 'Create'}</button></div>
    </form>
  </div>;
}
