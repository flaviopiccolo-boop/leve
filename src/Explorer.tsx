import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, FileCode2, FilePlus2, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { listFiles, movedPath, parentPath, validateName, type FileEntry } from './workspace';

type Edit = { mode: 'file' | 'folder'; parent: string } | { mode: 'rename'; entry: FileEntry };
interface Menu { left: number; top: number; entry: FileEntry | null }

export interface ExplorerActions {
  open: (path: string) => void;
  create: (parent: string, name: string, directory: boolean) => Promise<void>;
  rename: (path: string, name: string) => Promise<string>;
  remove: (entry: FileEntry) => Promise<void>;
}

interface TreeContext extends ExplorerActions {
  refresh: number;
  expanded: Set<string>;
  edit: Edit | null;
  setEdit: (edit: Edit | null) => void;
  toggle: (path: string) => void;
  showMenu: (event: MouseEvent, entry: FileEntry | null) => void;
  submit: (name: string) => Promise<void>;
}

function NameInput({ depth, initial, directory, label, onSubmit, onCancel }: { depth: number; initial: string; directory: boolean; label: string; onSubmit: (name: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const [failure, setFailure] = useState('');
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    // Keep the extension out of the selection, so typing replaces only the name.
    const dot = directory ? -1 : initial.lastIndexOf('.');
    input.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [directory, initial]);
  const problem = value.trim() ? validateName(value.trim()) : '';
  const commit = async () => {
    const name = value.trim();
    if (pending.current) return;
    if (!name || name === initial) { onCancel(); return; }
    if (problem) return;
    pending.current = true;
    try { await onSubmit(name); }
    catch (error) { setFailure(String(error).replace(/^Error: /, '')); }
    finally { pending.current = false; }
  };
  const message = problem || failure;
  return <div className="tree-edit" style={{ paddingLeft: 12 + depth * 15 }}>
    <input ref={input} aria-label={label} aria-invalid={!!message} spellCheck={false} value={value}
      onChange={event => { setValue(event.target.value); setFailure(''); }}
      onBlur={() => { if (message) onCancel(); else void commit(); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') void commit();
        if (event.key === 'Escape') onCancel();
      }} />
    {message && <p className="tree-edit-error" role="alert">{message}</p>}
  </div>;
}

function Tree({ path, depth, context }: { path: string; depth: number; context: TreeContext }) {
  const { refresh, expanded, edit, setEdit, toggle, showMenu, submit, open, remove } = context;
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    void listFiles(path).then(items => { if (active) setEntries(items); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [path, refresh]);
  const shortcuts = (event: KeyboardEvent, entry: FileEntry) => {
    if (event.key === 'F2') { event.preventDefault(); setEdit({ mode: 'rename', entry }); }
    if (event.key === 'Delete') { event.preventDefault(); void remove(entry); }
  };
  const creating = edit && edit.mode !== 'rename' && edit.parent === path;
  return <>
    {error && <p className="inline-error">{error}</p>}
    {creating && <NameInput depth={depth} initial="" directory={edit.mode === 'folder'} label={edit.mode === 'folder' ? 'New folder name' : 'New file name'} onSubmit={submit} onCancel={() => setEdit(null)} />}
    {entries.map(entry => <div key={entry.path}>
      {edit?.mode === 'rename' && edit.entry.path === entry.path
        ? <NameInput depth={depth} initial={entry.name} directory={entry.directory} label={`Rename ${entry.name}`} onSubmit={submit} onCancel={() => setEdit(null)} />
        : <button className="tree-item" style={{ paddingLeft: 12 + depth * 15 }} title={entry.path} aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
            onClick={() => { if (entry.directory) toggle(entry.path); else open(entry.path); }}
            onContextMenu={event => showMenu(event, entry)} onKeyDown={event => shortcuts(event, entry)}>
            {entry.directory ? <>{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={15} className="folder-icon" /></> : <><span className="tree-spacer" /><FileCode2 size={14} className={entry.name.endsWith('.py') ? 'python-icon' : 'file-icon'} /></>}
            <span>{entry.name}</span>
          </button>}
      {entry.directory && expanded.has(entry.path) && <Tree path={entry.path} depth={depth + 1} context={context} />}
    </div>)}
  </>;
}

export default function Explorer({ projectName, demo, blocked, refresh, onRefresh, onOpenFolder, actions }: {
  projectName: string; demo: boolean; blocked: boolean; refresh: number;
  onRefresh: () => void; onOpenFolder: () => void; actions: ExplorerActions;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['src']));
  const [edit, setEdit] = useState<Edit | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  const startCreate = (mode: 'file' | 'folder', parent: string) => {
    setMenu(null);
    if (parent) setExpanded(previous => new Set(previous).add(parent));
    setEdit({ mode, parent });
  };
  const submit = async (name: string) => {
    if (!edit) return;
    if (edit.mode === 'rename') {
      const { path } = edit.entry;
      const renamed = await actions.rename(path, name);
      setExpanded(previous => new Set([...previous].map(item => movedPath(item, path, renamed) ?? item)));
    } else await actions.create(edit.parent, name, edit.mode === 'folder');
    setEdit(null);
  };
  const showMenu = (event: MouseEvent, entry: FileEntry | null) => {
    event.preventDefault(); event.stopPropagation();
    if (!blocked) setMenu({ left: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)), top: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)), entry });
  };
  const target = menu?.entry ? (menu.entry.directory ? menu.entry.path : parentPath(menu.entry.path)) : '';
  const context: TreeContext = { ...actions, refresh, expanded, edit, setEdit, showMenu, submit, toggle: path => setExpanded(previous => {
    const next = new Set(previous);
    if (!next.delete(path)) next.add(path);
    return next;
  }) };

  return <div className="explorer panel-scroll" onContextMenu={event => showMenu(event, null)}>
    <div className="panel-heading"><span>PROJECT FOLDER</span><div>
      {!blocked && <><button className="icon-button" title="New file" onClick={() => startCreate('file', '')}><FilePlus2 size={14} /></button>
      <button className="icon-button" title="New folder" onClick={() => startCreate('folder', '')}><FolderPlus size={14} /></button></>}
      <button className="icon-button" title="Refresh files" onClick={onRefresh}><RefreshCw size={13} /></button>
      <button className="icon-button" title="Open folder" onClick={onOpenFolder}><FolderOpen size={15} /></button>
    </div></div>
    <div className="project-heading"><ChevronDown size={13} /><span>{projectName}</span>{demo && <span className="demo-badge">DEMO</span>}</div>
    {blocked ? <p className="panel-description">Project unavailable. Recovered files remain open.</p> : <Tree path="" depth={0} context={context} />}
    <button className="open-folder-link" onClick={onOpenFolder}><FolderOpen size={14} /> Open another folder</button>
    {menu && createPortal(<div className="terminal-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={event => { event.preventDefault(); setMenu(null); }} onKeyDown={event => { if (event.key === 'Escape') setMenu(null); }}>
      <div className="terminal-menu explorer-menu" role="menu" aria-label="File actions" style={{ left: menu.left, top: menu.top }} onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
        <button autoFocus role="menuitem" onClick={() => startCreate('file', target)}><FilePlus2 size={15} /><span>New file</span></button>
        <button role="menuitem" onClick={() => startCreate('folder', target)}><FolderPlus size={15} /><span>New folder</span></button>
        {menu.entry && <button role="menuitem" onClick={() => { setEdit({ mode: 'rename', entry: menu.entry! }); setMenu(null); }}><Pencil size={15} /><span>Rename</span></button>}
        {menu.entry && <button role="menuitem" onClick={() => { void actions.remove(menu.entry!); setMenu(null); }}><Trash2 size={15} /><span>Delete</span></button>}
      </div>
    </div>, document.body)}
  </div>;
}
