import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronDown, FilePlus2, FolderOpen, FolderPlus, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import { fileName, listFiles, native, pickSaveFolder, sortEntries, type FileEntry, type FileOperation } from './workspace';
import { gitStatuses, type GitDecorations } from './Git';
import ExplorerEntryIcons from './ExplorerEntryIcons';
import type { ExplorerPreferences } from './explorerPreferences';

type StartOperation = (operation: FileOperation, returnFocus?: HTMLElement | null) => void;
const TYPEAHEAD_TIMEOUT = 750;
const DIRECTORY_REFRESH_INTERVAL = 1500;

function searchName(value: string) {
  return value.normalize('NFD').replace(/\p{Mark}/gu, '').toLowerCase();
}

function Tree({ path = '', depth = 0, refresh, live, reveal, decorations, preferences, onOpen, onMenu, onOperation }: {
  path?: string; depth?: number; refresh: number; live: boolean; reveal: string; decorations: GitDecorations;
  preferences: ExplorerPreferences;
  onOpen: (path: string) => void;
  onMenu: (entry: FileEntry, x: number, y: number) => void;
  onOperation?: StartOperation;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const { foldersFirst, gitIndicators, icons } = preferences;
  const orderedEntries = useMemo(() => foldersFirst ? entries : sortEntries([...entries], false), [entries, foldersFirst]);
  const [expanded, setExpanded] = useState(new Set(['src']));
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only mounted branches are read. Wait for each listing to finish before scheduling another.
    const update = async (initial = false) => {
      try {
        if (initial || !document.hidden) {
          const items = await listFiles(path);
          if (!active) return;
          setEntries(previous => previous.length === items.length && previous.every((entry, index) => {
            const item = items[index];
            return entry.path === item.path && entry.name === item.name && entry.directory === item.directory;
          }) ? previous : items);
          setError('');
        }
      } catch (err) {
        if (active) setError(String(err));
      } finally {
        if (active && live) timer = setTimeout(() => void update(), DIRECTORY_REFRESH_INTERVAL);
      }
    };
    void update(true);
    return () => { active = false; clearTimeout(timer); };
  }, [path, refresh, live]);
  useEffect(() => {
    if (reveal) setExpanded(previous => {
      const next = new Set(previous);
      reveal.split('/').forEach((_, index, parts) => next.add(parts.slice(0, index + 1).join('/')));
      return next;
    });
  }, [reveal]);

  const handleEntryKey = (event: KeyboardEvent<HTMLButtonElement>, entry: FileEntry) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const button = event.currentTarget;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = button.getBoundingClientRect();
      onMenu(entry, rect.left, rect.bottom);
      return;
    }
    if (event.shiftKey) return;
    if (onOperation && (event.key === 'F2' || event.key === 'Delete')) {
      event.preventDefault();
      if (!event.repeat) onOperation({ kind: event.key === 'F2' ? 'rename' : 'delete', entry }, button);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const rows = Array.from(button.closest('.explorer-tree')!.querySelectorAll<HTMLButtonElement>('.tree-item'));
    const index = rows.indexOf(button);
    switch (event.key) {
      case 'ArrowUp': rows[index - 1]?.focus(); break;
      case 'ArrowDown': rows[index + 1]?.focus(); break;
      case 'Home': rows[0]?.focus(); break;
      case 'End': rows.at(-1)?.focus(); break;
      case 'ArrowRight':
        if (!entry.directory) break;
        if (!expanded.has(entry.path)) setExpanded(previous => new Set(previous).add(entry.path));
        else if (rows[index + 1]?.title.startsWith(entry.path + '/')) rows[index + 1].focus();
        break;
      case 'ArrowLeft':
        if (entry.directory && expanded.has(entry.path)) {
          setExpanded(previous => {
            const next = new Set(previous);
            next.delete(entry.path);
            return next;
          });
        } else {
          rows.find(row => row.title === path)?.focus();
        }
        break;
    }
  };
  return <>{error && <p className="inline-error">{error}</p>}{orderedEntries.map(entry => {
    const fileStatus = gitIndicators ? decorations.files.get(entry.path) : undefined;
    const folderStatus = gitIndicators && entry.directory ? decorations.folders.get(entry.path) : undefined;
    const status = fileStatus ?? folderStatus;
    const label = fileStatus ? gitStatuses[fileStatus].label : folderStatus ? 'Contains Git changes' : undefined;
    return <div key={entry.path}>
    <div className="tree-row" onContextMenu={event => onMenu(entry, event.clientX, event.clientY)}>
      <button className="tree-item" style={{ '--tree-indent': `${depth * 15}px` } as CSSProperties} title={entry.path} aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
        aria-description={label} aria-keyshortcuts={onOperation ? 'Delete F2 Shift+F10' : undefined} onKeyDown={event => handleEntryKey(event, entry)} onClick={() => {
        if (!entry.directory) onOpen(entry.path);
        else setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
      }}>
        <ExplorerEntryIcons name={entry.name} directory={entry.directory} expanded={expanded.has(entry.path)} style={icons} />
        <span className="tree-name" data-git-status={status}>{entry.name}</span>
        {status && <span className="tree-git-badge" data-git-status={status} title={label} aria-hidden="true">{fileStatus ? gitStatuses[fileStatus].badge : '●'}</span>}
      </button>
      <button className="icon-button tree-more" aria-label={`Actions for ${entry.path}`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onMenu(entry, rect.left, rect.bottom); }}><MoreHorizontal size={14} /></button>
    </div>
    {entry.directory && expanded.has(entry.path) && <Tree path={entry.path} depth={depth + 1} refresh={refresh} live={live} reveal={reveal} decorations={decorations} preferences={preferences} onOpen={onOpen} onMenu={onMenu} onOperation={onOperation} />}
    </div>;
  })}</>;
}

export default function Explorer({ root, blocked, visible, refresh, reveal, decorations, preferences, onRefresh, onOpen, onFolder, onOperation }: { root: string | null; blocked: boolean; visible: boolean; refresh: number; reveal: string; decorations: GitDecorations; preferences: ExplorerPreferences; onRefresh: () => void; onOpen: (path: string) => void; onFolder: () => void; onOperation: StartOperation }) {
  const [menu, setMenu] = useState<{ entry: FileEntry | null; left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const typeahead = useRef<{ prefix: string; time: number } | null>(null);
  const enabled = !blocked && (!native || !!root);
  const findTreeEntry = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.classList.contains('tree-item')) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (event.defaultPrevented || Array.from(event.key).length !== 1) {
      typeahead.current = null;
      return;
    }

    const now = performance.now();
    const previous = typeahead.current;
    const prefix = previous && now - previous.time < TYPEAHEAD_TIMEOUT ? previous.prefix : '';
    if (event.key === ' ' && !prefix) return;
    const key = searchName(event.key);
    if (!key) return;
    event.preventDefault();

    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.tree-item'));
    const index = rows.indexOf(target);
    const matchFrom = (start: number, query: string) => rows.slice(start).concat(rows.slice(0, start))
      .find(row => searchName(row.querySelector('.tree-name')?.textContent ?? '').startsWith(query));
    let query = prefix + key;
    let match = prefix ? matchFrom(index, query) : undefined;
    // Try a longer prefix first so repeated letters can match names such as ffmpeg.
    if (!prefix || (!match && prefix === key)) {
      query = key;
      match = matchFrom(index + 1, query);
    }
    typeahead.current = { prefix: query, time: now };
    match?.focus();
  };
  const action: StartOperation = (operation, returnFocus) => {
    setMenu(null);
    onOperation(operation, returnFocus);
  };
  const menuAction = (operation: FileOperation) => action(operation, menuOrigin.current);
  const openMenu = (entry: FileEntry | null, x: number, y: number) => {
    if (!enabled) return;
    const active = document.activeElement;
    menuOrigin.current = active instanceof HTMLElement && !menuRef.current?.contains(active) ? active : null;
    setMenu({
      entry,
      left: Math.max(8, Math.min(x, window.innerWidth - 210)),
      top: Math.max(8, Math.min(y, window.innerHeight - 200)),
    });
  };
  useEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) setMenu(null);
    };
    element.ownerDocument.addEventListener('pointerdown', dismissOutside, true);
    return () => element.ownerDocument.removeEventListener('pointerdown', dismissOutside, true);
  }, [menu]);
  const entry = menu?.entry;
  const parent = entry?.path ?? '';
  return <div className="explorer panel-layout">
    <div className="panel-heading panel-toolbar"><span>PROJECT FOLDER</span><div>
      <button className="icon-button" title="New file" disabled={!enabled} onClick={event => action({ kind: 'file', parent: '' }, event.currentTarget)}><FilePlus2 size={14} /></button>
      <button className="icon-button" title="New folder" disabled={!enabled} onClick={event => action({ kind: 'folder', parent: '' }, event.currentTarget)}><FolderPlus size={14} /></button>
      <button className="icon-button" title="Refresh files" onClick={onRefresh}><RefreshCw size={13} /></button>
      <button className="icon-button" title="Open folder" onClick={onFolder}><FolderOpen size={15} /></button>
    </div></div>
    <div className="panel-body explorer-body">
      <div className="project-heading"><ChevronDown size={13} /><span>{root ? fileName(root) : 'example-project'}</span>{!root && <span className="demo-badge">DEMO</span>}</div>
      {blocked ? <p className="panel-description">Project unavailable. Recovered files remain open.</p> : <div className="explorer-tree" data-density={preferences.density} data-indent-guides={preferences.indentGuides}
        onKeyDown={findTreeEntry}
        onPointerDown={() => { typeahead.current = null; }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) typeahead.current = null; }}>
        <Tree key={root ?? 'demo'} refresh={refresh} live={native && !!root && visible} reveal={reveal} decorations={decorations} preferences={preferences} onOpen={onOpen} onMenu={openMenu} onOperation={enabled ? action : undefined} />
      </div>}
      <div className="explorer-root-space" onContextMenu={event => openMenu(null, event.clientX, event.clientY)} />
    </div>
    {menu && <div key={parent} ref={menuRef} className="terminal-menu file-menu" role="menu" aria-label={entry ? `Actions for ${entry.name}` : 'Project root actions'} style={{ left: menu.left, top: menu.top }} onKeyDown={event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenu(null);
        menuOrigin.current?.focus();
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }}>
      {(!entry || entry.directory) && <>
        <button autoFocus role="menuitem" onClick={() => menuAction({ kind: 'file', parent })}>New file…</button>
        <button role="menuitem" onClick={() => menuAction({ kind: 'folder', parent })}>New folder…</button>
      </>}
      {entry && <>
        <button autoFocus={!entry.directory} role="menuitem" aria-keyshortcuts="F2" onClick={() => menuAction({ kind: 'rename', entry })}>Rename… <small aria-hidden="true">F2</small></button>
        <button role="menuitem" aria-keyshortcuts="Delete" onClick={() => menuAction({ kind: 'delete', entry })}>Delete… <small aria-hidden="true">Delete</small></button>
      </>}
    </div>}
  </div>;
}

export type FileDialogOperation = FileOperation | { kind: 'saveAs' | 'saveCopyAs'; path: string };

const saveExtensions = [
  ['txt', 'Plain text'], ['md', 'Markdown'], ['py', 'Python'], ['js', 'JavaScript'],
  ['ts', 'TypeScript'], ['json', 'JSON'], ['html', 'HTML'], ['css', 'CSS'],
  ['xml', 'XML'], ['yaml', 'YAML'], ['csv', 'CSV'],
] as const;

export function FileDialog({ operation, root, dirtyCount, busy, error, onCancel, onSubmit }: { operation: FileDialogOperation; root: string | null; dirtyCount: number; busy: boolean; error: string; onCancel: () => void; onSubmit: (name: string) => void }) {
  const savingAs = 'path' in operation;
  const [name, setName] = useState(() => {
    if (operation.kind === 'rename') return operation.entry.name;
    if (!savingAs) return '';
    const { path } = operation;
    if (operation.kind === 'saveAs') return path;
    const extension = path.lastIndexOf('.');
    const suffix = extension > path.lastIndexOf('/') + 1 ? extension : path.length;
    return `${path.slice(0, suffix)}-copy${path.slice(suffix)}`;
  });
  const [extension, setExtension] = useState('');
  const [folders, setFolders] = useState<FileEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const normalized = name.replaceAll('\\', '/');
  const separator = normalized.lastIndexOf('/');
  const folder = normalized.slice(0, separator + 1).replace(/\/$/, '');
  const basename = normalized.slice(separator + 1);
  useEffect(() => {
    if (!savingAs) return;
    let current = true;
    setFolders([]);
    void listFiles(folder).then(entries => {
      if (current) setFolders(entries.filter(entry => entry.directory));
    }).catch(() => { /* The destination can also be entered by hand. */ });
    return () => { current = false; };
  }, [folder, savingAs]);
  const selectFolder = (path: string) => {
    setBrowseError('');
    setName(path ? `${path}/${basename}` : basename);
  };
  const browse = async () => {
    if (!root) return;
    setBrowsing(true);
    setBrowseError('');
    try {
      const path = await pickSaveFolder(root, folder);
      if (path !== null) selectFolder(path);
    } catch (failure) {
      setBrowseError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBrowsing(false);
    }
  };
  const changeExtension = (value: string) => {
    setExtension(value);
    if (!value || !basename) return;
    const dot = basename.lastIndexOf('.');
    const stem = dot > 0 ? basename.slice(0, dot) : basename;
    setName(`${normalized.slice(0, separator + 1)}${stem}.${value}`);
  };
  const ancestors = folder ? folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')) : [];
  const disabled = busy || browsing;
  const deleting = operation.kind === 'delete';
  const title = operation.kind === 'saveCopyAs' ? 'Save a Copy As' : savingAs ? 'Save As' : deleting ? 'Delete permanently' : operation.kind === 'rename' ? 'Rename' : operation.kind === 'folder' ? 'New folder' : 'New file';
  return <div className="modal-backdrop" onKeyDown={event => {
    if (event.key === 'Escape' && !disabled) { event.stopPropagation(); onCancel(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      else if (!controls.length) event.preventDefault();
    }
  }}>
    <form className="file-dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={event => { event.preventDefault(); if (!disabled) onSubmit(name); }}>
      <div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Cancel file operation" disabled={disabled} onClick={onCancel}><X size={18} /></button></div>
      <p className="file-path">{savingAs ? 'Choose a folder and a file name inside the current project.' : 'entry' in operation ? operation.entry.path : operation.parent || 'Project root'}</p>
      {savingAs && <div className="file-folder-row">
        <label className="file-name-label">Save in<select value={folder} disabled={disabled} onChange={event => selectFolder(event.target.value)}>
          <option value="">Project root</option>
          {ancestors.map(path => <option key={path} value={path}>{path}</option>)}
          {folders.map(entry => <option key={entry.path} value={entry.path}>{entry.path}</option>)}
        </select></label>
        {native && root && <button type="button" className="button" disabled={disabled} onClick={() => void browse()}><FolderOpen size={15} />Browse…</button>}
      </div>}
      {deleting ? <p>This permanently deletes this {operation.entry.directory ? 'folder and all its contents' : 'file'} from disk. This cannot be undone.{dirtyCount > 0 && ` ${dirtyCount} open file(s) have unsaved changes that will also be discarded.`}</p> : <label className="file-name-label">{savingAs ? 'Destination path' : 'Name'}<input autoFocus required maxLength={savingAs ? undefined : 240} value={name} disabled={disabled} onFocus={event => event.target.select()} onChange={event => { setName(event.target.value); setExtension(''); setBrowseError(''); }} /></label>}
      {savingAs && <label className="file-name-label">Save as type<select value={extension} disabled={disabled || !basename} onChange={event => changeExtension(event.target.value)}>
        <option value="">All files (*.*)</option>
        {saveExtensions.map(([suffix, label]) => <option key={suffix} value={suffix}>{label} (*.{suffix})</option>)}
      </select></label>}
      {operation.kind === 'rename' && dirtyCount > 0 && <p>Unsaved edits will be kept under the new name.</p>}
      {(browseError || error) && <p className="inline-error" role="alert">{browseError || error}</p>}
      <div className="file-dialog-actions"><button type="button" autoFocus={deleting} className="button" disabled={disabled} onClick={onCancel}>Cancel</button><button className="button primary" disabled={disabled || (!deleting && !(savingAs ? basename : name).trim())}>{busy ? 'Working…' : savingAs ? 'Save' : deleting ? 'Delete permanently' : operation.kind === 'rename' ? 'Rename' : 'Create'}</button></div>
    </form>
  </div>;
}
