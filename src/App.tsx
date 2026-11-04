import { lazy, Suspense, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Actions, DockLocation, Layout, Model, TabNode, type Action, type IJsonModel } from 'flexlayout-react';
import { Blocks, ChevronDown, ChevronRight, Code2, FileCode2, Files, Folder, FolderOpen, Keyboard, LayoutTemplate, Plus, RefreshCw, Search, Settings2, TerminalSquare, X } from 'lucide-react';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { useTheme } from './theme';
import { loadShells, previewShells, type ShellProfile } from './shells';
import { activateWorkspace, fileName, indexFiles, languageName, listFiles, native, pickWorkspace, readFile, writeFile, type FileEntry, type OpenFile } from './workspace';

const LAYOUT_KEY = 'leve.layout.v1';
const Editor = lazy(() => import('./Editor'));
const Terminal = lazy(() => import('./Terminal'));
const initialLayout = (): IJsonModel => ({
  global: { tabEnableRename: false, tabSetEnableClose: false, tabSetMinWidth: 170, tabSetMinHeight: 100, tabSetEnableMaximize: true },
  borders: [],
  layout: { type: 'row', weight: 100, children: [
    { type: 'tabset', id: 'navigation', weight: 20, enableDeleteWhenEmpty: false, children: [
      { type: 'tab', id: 'explorer', name: 'Explorer', component: 'explorer', enableClose: false },
      { type: 'tab', id: 'search', name: 'Search', component: 'search', enableClose: false },
    ] },
    { type: 'row', weight: 80, children: [
      { type: 'tabset', id: 'documents', weight: 73, enableDeleteWhenEmpty: false, children: [
        { type: 'tab', id: 'welcome', name: 'Welcome', component: 'welcome', enableClose: false },
      ] },
      { type: 'tabset', id: 'terminals', weight: 27, enableDeleteWhenEmpty: false, children: [
        { type: 'tab', id: 'terminal-1', name: 'PowerShell', component: 'terminal' },
      ] },
    ] },
  ] },
});

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const json = JSON.parse(raw) as IJsonModel;
      // Never restore file content or open shells from an earlier workspace.
      const panelNames: Record<string, string> = { explorer: 'Explorer', search: 'Search', welcome: 'Welcome' };
      const clean = (node: { children?: any[]; component?: string; selected?: number; name?: string; config?: { shellId?: string; autoStart?: boolean } }) => {
        if (node.component && panelNames[node.component]) node.name = panelNames[node.component];
        if (node.component === 'terminal') node.config = { ...node.config, autoStart: false };
        if (node.children) node.children = node.children.filter(n => n.component !== 'file');
        if (node.selected !== undefined) node.selected = 0;
        node.children?.forEach(clean);
      };
      clean(json.layout);
      const model = Model.fromJson(json);
      if (model.getNodeById('explorer') && model.getNodeById('search') && model.getNodeById('documents')) return model;
    }
  } catch { /* Fall back to the standard layout if stored data is incompatible. */ }
  return Model.fromJson(initialLayout());
}

function Tree({ path = '', depth = 0, refresh, onOpen }: { path?: string; depth?: number; refresh: number; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['src']));
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    void listFiles(path).then(items => { if (active) setEntries(items); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [path, refresh]);
  return <>{error && <p className="inline-error">{error}</p>}{entries.map(entry => <div key={entry.path}>
    <button className="tree-item" style={{ paddingLeft: 12 + depth * 15 }} title={entry.path} aria-expanded={entry.directory ? expanded.has(entry.path) : undefined} onClick={() => {
      if (!entry.directory) onOpen(entry.path);
      else setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
    }}>
      {entry.directory ? <>{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={15} className="folder-icon" /></> : <><span className="tree-spacer" /><FileCode2 size={14} className={entry.name.endsWith('.py') ? 'python-icon' : 'file-icon'} /></>}
      <span>{entry.name}</span>
    </button>
    {entry.directory && expanded.has(entry.path) && <Tree path={entry.path} depth={depth + 1} refresh={refresh} onOpen={onOpen} />}
  </div>)}</>;
}

export default function App() {
  const { theme, setTheme } = useTheme();
  const [model, setModel] = useState(loadLayout);
  const [root, setRoot] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, OpenFile>>({});
  const filesRef = useRef(files); filesRef.current = files;
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState(false);
  const [profiles, setProfiles] = useState<ShellProfile[]>(native ? [] : previewShells);
  const [terminalMenu, setTerminalMenu] = useState<{ left: number; top: number } | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [position, setPosition] = useState({ line: 1, col: 1 });
  const [activeFile, setActiveFile] = useState('');
  const allowClose = useRef(false);
  const opening = useRef(new Set<string>());
  const saving = useRef(new Set<string>());
  const generation = useRef(0);
  const fileIndex = useRef<Promise<FileEntry[]> | null>(null);

  const notify = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    let active = true;
    void loadShells().then(items => { if (active) setProfiles(items); }).catch(error => { if (active) notify(`Could not detect shells: ${String(error)}`); });
    return () => { active = false; };
  }, [notify]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); } }, [notice]);

  const persist = (current: Model) => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(current.toJson())); } catch { /* Storage can be unavailable in private mode. */ }
  };

  const openFile = useCallback(async (path: string) => {
    const id = `file:${path}`;
    if (model.getNodeById(id)) { model.doAction(Actions.selectTab(id)); setActiveFile(path); return; }
    if (opening.current.has(path)) return;
    opening.current.add(path);
    const currentGeneration = generation.current;
    try {
      const content = await readFile(path);
      if (generation.current !== currentGeneration) return;
      setFiles(previous => ({ ...previous, [path]: { path, name: fileName(path), content, saved: content } }));
      const target = model.getNodeById('documents');
      if (target) model.doAction(Actions.addNode({ type: 'tab', id, name: fileName(path), component: 'file', config: { path } }, target.getId(), DockLocation.CENTER, -1));
      setActiveFile(path);
    } catch (error) { notify(`Could not open file: ${String(error)}`); }
    finally { opening.current.delete(path); }
  }, [model, notify]);

  const saveFile = useCallback(async (path: string) => {
    const file = filesRef.current[path];
    if (!file || file.content === file.saved || saving.current.has(path)) return;
    saving.current.add(path);
    const currentGeneration = generation.current;
    try {
      await writeFile(file);
      if (generation.current !== currentGeneration) return;
      setFiles(previous => previous[path] ? ({ ...previous, [path]: { ...previous[path], saved: file.content } }) : previous);
      notify(root ? `${file.name} saved.` : `${file.name} saved only in this demo session.`);
    } catch (error) { notify(`Could not save file: ${String(error)}`); }
    finally { saving.current.delete(path); }
  }, [notify, root]);

  const canDiscard = async () => {
    if (!Object.values(filesRef.current).some(file => file.content !== file.saved)) return true;
    const message = 'You have unsaved changes. Discard them?';
    return native ? confirmDialog(message, { title: 'Unsaved changes', kind: 'warning' }) : window.confirm(message);
  };

  const openFolder = async () => {
    if (!native) { notify('The preview uses demo files. Open the desktop app to select a real folder.'); return; }
    try {
      const selectedPath = await pickWorkspace();
      if (!selectedPath || !await canDiscard()) return;
      const selected = await activateWorkspace(selectedPath);
      generation.current += 1;
      setRoot(selected); setFiles({}); setActiveFile(''); setQuery(''); setMatches([]);
      setModel(Model.fromJson(initialLayout())); setRefresh(value => value + 1);
    } catch (error) { notify(String(error)); }
  };

  const addTerminal = (shellId = 'powershell') => {
    if (native && !root) { notify('Open a folder before starting a terminal.'); return; }
    const profile = profiles.find(item => item.id === shellId);
    if (!profile?.available) { notify('This terminal is not installed or is still being detected.'); return; }
    const id = `terminal-${crypto.randomUUID()}`;
    const target = model.getNodeById('terminals') || model.getNodeById('documents');
    if (target) model.doAction(Actions.addNode({ type: 'tab', id, name: profile.name, component: 'terminal', config: { shellId, autoStart: true } }, target.getId(), DockLocation.CENTER, -1));
    setTerminalMenu(null);
  };

  const openTerminalMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTerminalMenu({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)), top: rect.bottom + 240 < window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - 240) });
    void loadShells().then(setProfiles).catch(error => notify(`Could not detect shells: ${String(error)}`));
  };

  useEffect(() => { fileIndex.current = null; }, [refresh]);

  useEffect(() => {
    if (!query.trim()) { setMatches([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      fileIndex.current ??= indexFiles();
      void fileIndex.current.then(entries => {
        if (!cancelled) setMatches(entries.filter(entry => entry.path.toLowerCase().includes(query.toLowerCase())).slice(0, 100));
      }).catch(error => { if (!cancelled) notify(String(error)); }).finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, refresh, notify]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.values(filesRef.current).some(file => file.content !== file.saved)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  useEffect(() => {
    if (!native) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const stop = await getCurrentWindow().onCloseRequested(async event => {
        event.preventDefault();
        if (await canDiscard()) await getCurrentWindow().destroy();
      });
      if (cancelled) stop(); else dispose = stop;
    });
    return () => { cancelled = true; dispose?.(); };
  }, []);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTerminalMenu(null);
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); if (activeFile) void saveFile(activeFile); }
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault(); model.doAction(Actions.selectTab('search'));
        setTimeout(() => document.getElementById('file-search')?.focus(), 0);
      }
      if (event.key === '`') { event.preventDefault(); addTerminal(); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  });

  const onAction = (action: Action) => {
    if (action.type === Actions.DELETE_TAB && !allowClose.current) {
      const tab = model.getNodeById(action.data.node) as TabNode | undefined;
      const path = tab?.getConfig()?.path;
      const file = filesRef.current[path];
      if (file && file.content !== file.saved) {
        void (native ? confirmDialog(`Discard changes to ${file.name}?`, { title: 'Close file', kind: 'warning' }) : Promise.resolve(window.confirm(`Discard changes to ${file.name}?`))).then(accepted => {
          if (accepted) {
            allowClose.current = true; model.doAction(action); allowClose.current = false;
            setFiles(previous => { const next = { ...previous }; delete next[path]; return next; });
          }
        });
        return undefined;
      }
    }
    if (action.type === Actions.DELETE_TAB) {
      const tab = model.getNodeById(action.data.node) as TabNode | undefined;
      const path = tab?.getConfig()?.path;
      if (path) setFiles(previous => { const next = { ...previous }; delete next[path]; return next; });
    }
    return action;
  };

  const factory = (node: TabNode): ReactNode => {
    switch (node.getComponent()) {
      case 'explorer': return <div className="explorer panel-scroll">
        <div className="panel-heading"><span>PROJECT FOLDER</span><div><button className="icon-button" title="Refresh files" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} /></button><button className="icon-button" title="Open folder" onClick={() => void openFolder()}><FolderOpen size={15} /></button></div></div>
        <div className="project-heading"><ChevronDown size={13} /><span>{root ? fileName(root) : 'example-project'}</span>{!root && <span className="demo-badge">DEMO</span>}</div>
        <Tree key={root ?? 'demo'} refresh={refresh} onOpen={path => void openFile(path)} />
        <button className="open-folder-link" onClick={() => void openFolder()}><FolderOpen size={14} /> Open another folder</button>
      </div>;
      case 'search': return <div className="search-panel panel-scroll"><div className="panel-heading">FIND FILES</div>
        <label className="search-input"><Search size={14} /><input id="file-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="File name or path" /></label>
        <p className="panel-description">{searching ? 'Searching…' : query ? `${matches.length} result(s)` : 'Find files in your project. Use Ctrl+F to search within the code.'}</p>
        {matches.map(entry => <button className="search-result" key={entry.path} onClick={() => void openFile(entry.path)}><FileCode2 size={14} /><span>{entry.name}<small>{entry.path}</small></span></button>)}
        {query && <p className="panel-description">Up to 5,000 files · skips dependencies and build folders.</p>}
      </div>;
      case 'file': {
        const file = files[node.getConfig().path];
        return file ? <Suspense fallback={<p className="panel-description">Loading editor…</p>}><Editor file={file} onChange={(path, content) => setFiles(previous => ({ ...previous, [path]: { ...previous[path], content } }))} onSave={path => void saveFile(path)} onCursor={(line, col) => setPosition({ line, col })} /></Suspense> : null;
      }
      case 'terminal': return <Suspense fallback={null}><Terminal id={node.getId()} root={root} shellId={node.getConfig()?.shellId} autoStart={node.getConfig()?.autoStart} profiles={profiles} onShellChange={shellId => {
        const profile = profiles.find(item => item.id === shellId);
        if (profile) model.doAction(Actions.updateNodeAttributes(node.getId(), { name: profile.name, config: { shellId, autoStart: false } }));
      }} /></Suspense>;
      default: return <div className="welcome panel-scroll"><div className="welcome-content">
        <div className="brand-mark"><Code2 size={36} strokeWidth={1.4} /></div>
        <div className="eyebrow">LESS DISTRACTION. MORE CODE.</div><h1>Room to create.</h1>
        <p>Your code at the center.<br />Your tools, wherever you need them.</p>
        <div className="welcome-actions"><button className="button primary" onClick={() => void openFolder()}><FolderOpen size={16} /> Open folder <kbd>Local</kbd></button>
        <button className="button secondary" onClick={() => void openFile('src/main.py')} disabled={!!root}><FileCode2 size={16} /> Explore demo</button></div>
        <div className="welcome-hints"><div><span>Find file</span><kbd>Ctrl P</kbd></div><div><span>Save file</span><kbd>Ctrl S</kbd></div><div><span>New terminal</span><kbd>Ctrl `</kbd></div></div>
        <div className="layout-tip"><Blocks size={16} /><span>Drag tabs to rearrange your workspace.</span></div>
      </div><span className="welcome-version">LEVE EDITOR · EARLY PREVIEW</span></div>;
    }
  };

  return <div className="app-shell">
    <header className="titlebar"><div className="app-name"><Code2 size={18} /><strong>leve</strong><span className="preview-tag">preview</span></div>
      <button className="project-picker" onClick={() => void openFolder()}><Folder size={13} /><span>{root ? fileName(root) : 'No folder open'}</span><ChevronDown size={12} /></button>
      <button className="icon-button" title="Layout and shortcuts" onClick={() => setSettings(true)}><Settings2 size={16} /></button>
    </header>
    <div className="workspace"><aside className="activity-bar" aria-label="Navigation">
      <button title="Explorer" className="activity-button" onClick={() => model.doAction(Actions.selectTab('explorer'))}><Files size={21} /></button>
      <button title="Find files (Ctrl+P)" className="activity-button" onClick={() => { model.doAction(Actions.selectTab('search')); setTimeout(() => document.getElementById('file-search')?.focus(), 0); }}><Search size={21} /></button>
      <button title="New terminal" className="activity-button" onClick={openTerminalMenu}><TerminalSquare size={21} /></button>
      <div className="activity-spacer" /><button title="Settings" className="activity-button" onClick={() => setSettings(true)}><Settings2 size={21} /></button>
    </aside><main className="layout-host"><Layout model={model} factory={factory} onAction={onAction}
      onModelChange={current => { persist(current); const active = current.getActiveTabset()?.getSelectedNode(); if (active instanceof TabNode && active.getComponent() === 'file') setActiveFile(active.getConfig().path); }}
      onRenderTab={(node, values) => {
        const path = node.getConfig()?.path;
        const dirty = path && files[path]?.content !== files[path]?.saved;
        if (dirty) values.content = <span>{node.getName()}<span className="dirty-dot" title="Unsaved changes">●</span></span>;
      }}
      onRenderTabSet={(node, values) => { if (node.getId() === 'terminals') values.buttons.push(<button key="new" className="icon-button" title="New terminal" aria-haspopup="menu" onClick={openTerminalMenu}><Plus size={14} /></button>); }}
    /></main></div>
    <footer className="statusbar"><span className="status-indicator" />{native ? 'Local' : 'Web preview'}<span className="status-divider" /><span>{root ? fileName(root) : 'Demo project'}</span><div className="status-spacer" /><span>Ln {position.line}, Col {position.col}</span><span>UTF-8</span><span>{activeFile ? languageName(activeFile) : 'Leve'}</span></footer>
    {notice && <div className="toast" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {terminalMenu && <div className="terminal-menu-backdrop" onClick={() => setTerminalMenu(null)} onKeyDown={event => { if (event.key === 'Escape') setTerminalMenu(null); }}>
      <div className="terminal-menu" role="menu" aria-label="New terminal" style={terminalMenu} onClick={event => event.stopPropagation()}>
        <div className="terminal-menu-heading">NEW TERMINAL</div>
        {profiles.map((profile, index) => <button autoFocus={index === 0} role="menuitem" key={profile.id} disabled={!profile.available || (native && !root)} onClick={() => addTerminal(profile.id)}><TerminalSquare size={15} /><span>{profile.name}</span>{!profile.available && <small>Not installed</small>}</button>)}
        <p>{!native ? 'Preview only. Shell availability is checked in the desktop app.' : !root ? 'Open a folder to start a terminal.' : 'Starts immediately in your project folder.'}</p>
      </div>
    </div>}
    {settings && <div className="modal-backdrop" onClick={() => setSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="Layout and shortcuts" onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><h2>Your workspace</h2><button className="icon-button" aria-label="Close settings" onClick={() => setSettings(false)}><X size={18} /></button></div>
      <fieldset className="theme-picker"><legend>Appearance</legend><div className="theme-options">
        <label className={theme === 'dark' ? 'theme-option selected' : 'theme-option'}><input type="radio" name="theme" value="dark" checked={theme === 'dark'} onChange={() => setTheme('dark')} /><span>Dark</span></label>
        <label className={theme === 'light' ? 'theme-option selected' : 'theme-option'}><input type="radio" name="theme" value="light" checked={theme === 'light'} onChange={() => setTheme('light')} /><span>Light</span></label>
      </div><p>Your preference is saved automatically.</p></fieldset>
      <p>Drag tabs to move panels. Drop at the edges to split the area, or onto another group to combine tabs.</p>
      <button className="button" onClick={() => {
        const fresh = Model.fromJson(initialLayout());
        Object.values(filesRef.current).forEach(file => fresh.doAction(Actions.addNode({ type: 'tab', id: `file:${file.path}`, component: 'file', name: file.name, config: { path: file.path } }, 'documents', DockLocation.CENTER, -1)));
        setModel(fresh); persist(fresh); setSettings(false);
      }}><LayoutTemplate size={16} /> Reset layout</button>
      <div className="settings-shortcuts"><Keyboard size={17} /><span>Ctrl+P · Find file<br />Ctrl+S · Save<br />Ctrl+F · Search in code<br />Ctrl+` · New terminal</span></div>
      <p className="subtle">Resetting the layout closes open terminal sessions. Files and editor changes are preserved.</p>
    </section></div>}
  </div>;
}
