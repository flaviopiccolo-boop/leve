import { lazy, Suspense, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Actions, DockLocation, Layout, Model, TabNode, TabSetNode, type Action, type IJsonModel } from 'flexlayout-react';
import { Blocks, ChevronDown, Code2, FileCode2, Files, Folder, FolderOpen, Keyboard, LayoutTemplate, Plus, Search, Settings2, TerminalSquare, X } from 'lucide-react';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { useTheme } from './theme';
import { loadShells, previewShells, type ShellProfile } from './shells';
import { loadSession, restoreFiles, saveSession, type Session } from './session';
import { loadProjects, rememberProject, sameProject } from './projects';
import Explorer from './Explorer';
import { activateWorkspace, createPath, deletePath, fileName, indexFiles, languageName, movedPath, native, pickWorkspace, readFile, renamePath, usesRecycleBin, writeFile, type FileEntry, type OpenFile } from './workspace';

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
      { type: 'tabset', id: 'terminals', weight: 27, enableDeleteWhenEmpty: false, children: [] },
    ] },
  ] },
});

function loadLayout(savedLayout?: IJsonModel, restoredFiles?: Set<string>) {
  try {
    const raw = savedLayout ? JSON.stringify(savedLayout) : localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const json = JSON.parse(raw) as IJsonModel;
      // Restore only validated file buffers, and never restart terminal sessions.
      const panelNames: Record<string, string> = { explorer: 'Explorer', search: 'Search', welcome: 'Welcome' };
      const clean = (node: { children?: any[]; component?: string; selected?: number; name?: string; config?: { path?: string } }) => {
        if (node.component && panelNames[node.component]) node.name = panelNames[node.component];
        if (node.children) node.children = node.children.filter(n => n.component !== 'terminal' && (n.component !== 'file' || restoredFiles?.has(n.config?.path)));
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

export default function App() {
  const { theme, setTheme } = useTheme();
  const [model, setModel] = useState(loadLayout);
  const [root, setRoot] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, OpenFile>>({});
  const filesRef = useRef(files); filesRef.current = files;
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState(false);
  const [projects, setProjects] = useState(loadProjects);
  const [projectMenu, setProjectMenu] = useState(false);
  const [switchingProject, setSwitchingProject] = useState(false);
  const projectPicker = useRef<HTMLButtonElement>(null);
  const [profiles, setProfiles] = useState<ShellProfile[]>(native ? [] : previewShells);
  const [terminalMenu, setTerminalMenu] = useState<{ left: number; top: number } | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [position, setPosition] = useState({ line: 1, col: 1 });
  const [activeFile, setActiveFile] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState('');
  const [recoveryWarning, setRecoveryWarning] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryLocked, setRecoveryLocked] = useState(false);
  const [checkpointTime, setCheckpointTime] = useState('');
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [closing, setClosing] = useState(false);
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRef = useRef({ root, files, activeFile, model, sessionReady, recoveryLocked });
  sessionRef.current = { root, files, activeFile, model, sessionReady, recoveryLocked };
  const allowClose = useRef(false);
  const opening = useRef(new Set<string>());
  const saving = useRef(new Set<string>());
  const generation = useRef(0);
  const fileIndex = useRef<Promise<FileEntry[]> | null>(null);

  const notify = useCallback((message: string) => setNotice(message), []);
  const remember = useCallback((path: string) => {
    try { setProjects(rememberProject(path)); }
    catch { notify('The project opened, but its history could not be saved.'); }
  }, [notify]);
  const snapshot = useCallback((): Session => {
    const current = sessionRef.current;
    return { version: 1, root: current.root, files: Object.values(current.files), activeFile: current.activeFile, layout: current.model.toJson() };
  }, []);
  const checkpoint = useCallback(async () => {
    if (!sessionRef.current.sessionReady || sessionRef.current.recoveryLocked) return false;
    try {
      await saveSession(snapshot());
      setRecoveryError(''); setCheckpointTime(checkpointTimer.current ? '' : new Date().toLocaleTimeString());
      return true;
    } catch (error) { setRecoveryError(`Recovery could not be saved: ${String(error)}. Save your files before closing.`); return false; }
  }, [snapshot]);

  const recoverSession = useCallback(async () => {
    setSessionReady(false);
    try {
      const saved = await loadSession();
      if (saved) {
        let openedRoot = saved.root;
        let blocked = '';
        if (saved.root && native) {
          try { openedRoot = await activateWorkspace(saved.root); }
          catch (error) { blocked = `Could not reopen ${saved.root}: ${String(error)}. Recovered buffers are preserved; reopen the project before saving to disk.`; }
        }
        const restored = blocked ? { files: Object.fromEntries(saved.files.map(file => [file.path, file])), warnings: [], recovered: saved.files.filter(file => file.content !== file.saved).length } : await restoreFiles(saved.files);
        const nextModel = loadLayout(saved.layout, new Set(Object.keys(restored.files)));
        // Include buffers whose original docking group no longer exists.
        for (const file of Object.values(restored.files)) {
          if (!nextModel.getNodeById(`file:${file.path}`)) nextModel.doAction(Actions.addNode({ type: 'tab', id: `file:${file.path}`, name: file.name, component: 'file', config: { path: file.path } }, 'documents', DockLocation.CENTER, -1));
        }
        const selected = restored.files[saved.activeFile] ? saved.activeFile : Object.keys(restored.files)[0] || '';
        if (selected) nextModel.doAction(Actions.selectTab(`file:${selected}`));
        setRoot(openedRoot); setFiles(restored.files); setModel(nextModel); setActiveFile(selected);
        if (openedRoot && !blocked) remember(openedRoot);
        setRecoveryBlocked(blocked); setRecoveryWarning(restored.warnings.join(' '));
        setRecoveryLocked(false); setRecoveryError(''); setRefresh(value => value + 1);
        if (restored.recovered) notify(`Recovered unsaved changes in ${restored.recovered} file(s).`);
      }
    } catch (error) { setRecoveryLocked(true); setRecoveryError(`Could not load recovery: ${String(error)}. Existing data has been preserved.`); }
    finally { setSessionReady(true); }
  }, [notify, remember]);
  useEffect(() => { void recoverSession(); }, [recoverSession]);
  useEffect(() => {
    if (!sessionReady || recoveryLocked) return;
    setCheckpointTime('');
    if (checkpointTimer.current) return;
    // Throttle checkpoints so continuous typing is backed up too.
    checkpointTimer.current = setTimeout(() => { checkpointTimer.current = undefined; void checkpoint(); }, 400);
  }, [files, root, activeFile, model, layoutVersion, sessionReady, recoveryLocked, checkpoint]);
  useEffect(() => () => { if (checkpointTimer.current) clearTimeout(checkpointTimer.current); }, []);
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
    if (recoveryBlocked) { notify('Reopen the project before opening additional files.'); return; }
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
  }, [model, notify, recoveryBlocked]);

  const saveFile = useCallback(async (path: string) => {
    if (recoveryBlocked) { notify('Reopen the original project before saving recovered changes to disk.'); return; }
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
  }, [notify, root, recoveryBlocked]);

  const confirmAction = (message: string, title: string) => native ? confirmDialog(message, { title, kind: 'warning' }) : Promise.resolve(window.confirm(message));

  const createEntry = useCallback(async (parent: string, name: string, directory: boolean) => {
    const path = await createPath(parent, name, directory);
    setRefresh(value => value + 1);
    if (!directory) void openFile(path);
  }, [openFile]);

  // Tab ids contain the path, so a moved file needs a replacement tab in the same position.
  const renameEntry = useCallback(async (path: string, name: string) => {
    const affected = Object.keys(filesRef.current).filter(item => movedPath(item, path, '') !== null);
    if (affected.some(item => saving.current.has(item))) throw new Error('Wait for the file to finish saving.');
    const renamed = await renamePath(path, name);
    const moved = (item: string) => movedPath(item, path, renamed) ?? item;
    setFiles(previous => Object.fromEntries(Object.values(previous).map(file => {
      const next = moved(file.path);
      return [next, next === file.path ? file : { ...file, path: next, name: fileName(next) }];
    })));
    setActiveFile(moved);
    const current = sessionRef.current.model;
    for (const item of affected) {
      const tab = current.getNodeById(`file:${item}`) as TabNode | undefined;
      const parent = tab?.getParent();
      if (!tab || !parent) continue;
      const next = moved(item);
      // Add before deleting: a split group disappears when its last tab closes.
      const selected = 'getSelectedNode' in parent && (parent as TabSetNode).getSelectedNode() === tab;
      current.doAction(Actions.addNode({ ...tab.toJson(), id: `file:${next}`, name: fileName(next), config: { path: next } }, parent.getId(), DockLocation.CENTER, parent.getChildren().indexOf(tab) + 1, selected));
      current.doAction(Actions.deleteTab(tab.getId()));
    }
    setRefresh(value => value + 1);
    return renamed;
  }, []);

  const deleteEntry = useCallback(async (entry: FileEntry) => {
    const affected = Object.values(filesRef.current).filter(file => movedPath(file.path, entry.path, '') !== null);
    const unsaved = affected.filter(file => file.content !== file.saved).length;
    const bin = usesRecycleBin();
    const message = `${bin ? `Move ${entry.name} to the Recycle Bin?` : `Delete ${entry.name}?`}${entry.directory ? ' All of its contents will be included.' : ''}${unsaved ? ` Unsaved changes in ${unsaved} open file(s) will be lost.` : ''}`;
    if (!await confirmAction(message, entry.directory ? 'Delete folder' : 'Delete file')) return;
    try { await deletePath(entry.path); }
    catch (error) { notify(`Could not delete ${entry.name}: ${String(error)}`); return; }
    const current = sessionRef.current.model;
    for (const file of affected) if (current.getNodeById(`file:${file.path}`)) current.doAction(Actions.deleteTab(`file:${file.path}`));
    setFiles(previous => Object.fromEntries(Object.entries(previous).filter(([path]) => movedPath(path, entry.path, '') === null)));
    setActiveFile(path => movedPath(path, entry.path, '') === null ? path : '');
    setRefresh(value => value + 1);
    notify(bin ? `${entry.name} moved to the Recycle Bin.` : `${entry.name} deleted from this demo session.`);
  }, [notify]);

  const canDiscard = async () => {
    if (!Object.values(filesRef.current).some(file => file.content !== file.saved)) return true;
    const message = 'You have unsaved changes. Discard them?';
    return native ? confirmDialog(message, { title: 'Unsaved changes', kind: 'warning' }) : window.confirm(message);
  };

  const openFolder = async (recentPath?: string) => {
    setProjectMenu(false);
    if (switchingProject) return;
    if (recentPath && root && sameProject(recentPath, root) && !recoveryBlocked) return;
    if (!native) { notify('The preview uses demo files. Open the desktop app to select a real folder.'); return; }
    setSwitchingProject(true);
    try {
      const selectedPath = recentPath ?? await pickWorkspace();
      if (!selectedPath || !await canDiscard()) return;
      if (recoveryLocked && !await confirmDialog('Replace the unreadable recovery snapshot with a new session?', { title: 'Start a new session', kind: 'warning' })) return;
      const selected = await activateWorkspace(selectedPath);
      remember(selected);
      generation.current += 1;
      setRoot(selected); setFiles({}); setActiveFile(''); setQuery(''); setMatches([]);
      setRecoveryLocked(false); setRecoveryBlocked(''); setRecoveryWarning(''); setRecoveryError('');
      setModel(Model.fromJson(initialLayout())); setRefresh(value => value + 1);
    } catch (error) { notify(`Could not open project: ${String(error)}`); }
    finally { setSwitchingProject(false); projectPicker.current?.focus(); }
  };

  const addTerminal = (shellId = 'powershell') => {
    if (recoveryBlocked) { notify('Reopen the project before creating a terminal.'); return; }
    const profile = profiles.find(item => item.id === shellId);
    if (!profile?.available) { notify('This terminal is not installed or is still being detected.'); return; }
    const id = `terminal-${crypto.randomUUID()}`;
    const target = model.getNodeById('terminals') || model.getNodeById('documents');
    if (target) model.doAction(Actions.addNode({ type: 'tab', id, name: profile.name, component: 'terminal', config: { shellId } }, target.getId(), DockLocation.CENTER, -1));
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
      if (!sessionRef.current.sessionReady) return;
      if (sessionRef.current.recoveryLocked) {
        if (Object.values(filesRef.current).some(file => file.content !== file.saved)) { event.preventDefault(); event.returnValue = ''; }
        return;
      }
      try { void saveSession(snapshot()).catch(error => setRecoveryError(String(error))); }
      catch { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [snapshot]);

  useEffect(() => {
    if (!native) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const stop = await getCurrentWindow().onCloseRequested(async event => {
        event.preventDefault();
        setClosing(true);
        if (await checkpoint() || await confirmDialog('Recovery could not be saved. Close anyway? Unsaved changes may be lost.', { title: 'Recovery unavailable', kind: 'warning' })) await getCurrentWindow().destroy();
        else setClosing(false);
      });
      if (cancelled) stop(); else dispose = stop;
    });
    return () => { cancelled = true; dispose?.(); };
  }, [checkpoint]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setTerminalMenu(null); setProjectMenu(false); if (projectMenu) projectPicker.current?.focus(); }
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
      case 'explorer': return <Explorer key={root ?? 'demo'} projectName={root ? fileName(root) : 'example-project'} demo={!root} blocked={!!recoveryBlocked} refresh={refresh}
        onRefresh={() => setRefresh(value => value + 1)} onOpenFolder={() => void openFolder()}
        actions={{ open: path => void openFile(path), create: createEntry, rename: renameEntry, remove: deleteEntry }} />;
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
      case 'terminal': return <Suspense fallback={null}><Terminal id={node.getId()} shellId={node.getConfig()?.shellId} /></Suspense>;
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
      <button ref={projectPicker} className="project-picker" title={root || 'Switch project'} aria-haspopup="menu" aria-expanded={projectMenu} aria-controls={projectMenu ? 'project-menu' : undefined} disabled={switchingProject} onClick={() => setProjectMenu(value => !value)}><Folder size={13} /><span>{root ? fileName(root) : 'No folder open'}</span><ChevronDown size={12} /></button>
      <button className="icon-button" title="Layout and shortcuts" onClick={() => setSettings(true)}><Settings2 size={16} /></button>
    </header>
    {(recoveryBlocked || recoveryWarning || recoveryError) && <div className="recovery-banner" role="alert"><span>{recoveryBlocked || recoveryError || recoveryWarning}</span>
      {recoveryBlocked && <button className="button" onClick={() => { void checkpoint().then(saved => { if (saved) void recoverSession(); }); }}>Retry recovery</button>}
      {recoveryError && !recoveryLocked && !recoveryBlocked && <button className="button" onClick={() => void checkpoint()}>Retry backup</button>}
      {recoveryLocked && <button className="button" onClick={async () => {
        const accepted = native ? await confirmDialog('Replace the unreadable recovery snapshot? Existing recovery copies will be kept where possible.', { title: 'Start a new session', kind: 'warning' }) : window.confirm('Replace the unreadable recovery snapshot?');
        if (accepted) { setRecoveryLocked(false); setRecoveryError(''); }
      }}>Start a new session</button>}
      {!recoveryBlocked && !recoveryError && <button className="icon-button" aria-label="Dismiss recovery warning" onClick={() => setRecoveryWarning('')}><X size={15} /></button>}
    </div>}
    <div className="workspace"><aside className="activity-bar" aria-label="Navigation">
      <button title="Explorer" className="activity-button" onClick={() => model.doAction(Actions.selectTab('explorer'))}><Files size={21} /></button>
      <button title="Find files (Ctrl+P)" className="activity-button" onClick={() => { model.doAction(Actions.selectTab('search')); setTimeout(() => document.getElementById('file-search')?.focus(), 0); }}><Search size={21} /></button>
      <button title="New terminal" className="activity-button" onClick={openTerminalMenu}><TerminalSquare size={21} /></button>
      <div className="activity-spacer" /><button title="Settings" className="activity-button" onClick={() => setSettings(true)}><Settings2 size={21} /></button>
    </aside><main className="layout-host"><Layout model={model} factory={factory} onAction={onAction}
      onModelChange={current => { persist(current); setLayoutVersion(value => value + 1); const active = current.getActiveTabset()?.getSelectedNode(); if (active instanceof TabNode && active.getComponent() === 'file') setActiveFile(active.getConfig().path); }}
      onRenderTab={(node, values) => {
        const path = node.getConfig()?.path;
        const dirty = path && files[path]?.content !== files[path]?.saved;
        if (dirty) values.content = <span>{node.getName()}<span className="dirty-dot" title="Unsaved changes">●</span></span>;
      }}
      onRenderTabSet={(node, values) => { if (node.getId() === 'terminals') values.buttons.push(<button key="new" className="icon-button" title="New terminal" aria-haspopup="menu" onClick={openTerminalMenu}><Plus size={14} /></button>); }}
    /></main></div>
    <footer className="statusbar"><span className="status-indicator" />{native ? 'Local' : 'Web preview'}<span className="status-divider" /><span>{root ? fileName(root) : 'Demo project'}</span><div className="status-spacer" /><span title={checkpointTime ? `Last recovery checkpoint: ${checkpointTime}` : 'Preparing recovery'}>{recoveryError || recoveryLocked ? 'Recovery unavailable' : checkpointTime ? 'Recovery saved' : 'Recovery pending'}</span><span>Ln {position.line}, Col {position.col}</span><span>UTF-8</span><span>{activeFile ? languageName(activeFile) : 'Leve'}</span></footer>
    {(!sessionReady || closing) && <div className="session-loading" role="status">{closing ? 'Saving session…' : 'Restoring session…'}</div>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {projectMenu && <div className="project-menu-backdrop" onClick={() => { setProjectMenu(false); projectPicker.current?.focus(); }}>
      <div id="project-menu" className="project-menu" role="menu" aria-label="Recent projects" onClick={event => event.stopPropagation()} onKeyDown={event => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
        if (event.key === 'Tab') setProjectMenu(false);
      }}>
        <div className="terminal-menu-heading">RECENT PROJECTS</div>
        {!projects.length && <p>No recent projects yet.</p>}
        {projects.map((path, index) => <button autoFocus={index === 0} role="menuitem" key={path} title={path} onClick={() => void openFolder(path)}><Folder size={15} /><span><strong>{fileName(path)}</strong><small>{path}</small></span>{root && sameProject(path, root) && <small className="project-current">Current</small>}</button>)}
        <button autoFocus={!projects.length} className="project-browse" role="menuitem" onClick={() => void openFolder()}><FolderOpen size={15} /><span>Open another folder…</span></button>
      </div>
    </div>}
    {terminalMenu && <div className="terminal-menu-backdrop" onClick={() => setTerminalMenu(null)} onKeyDown={event => { if (event.key === 'Escape') setTerminalMenu(null); }}>
      <div className="terminal-menu" role="menu" aria-label="New terminal" style={terminalMenu} onClick={event => event.stopPropagation()}>
        <div className="terminal-menu-heading">NEW TERMINAL</div>
        {profiles.map((profile, index) => <button autoFocus={index === 0} role="menuitem" key={profile.id} disabled={!profile.available} onClick={() => addTerminal(profile.id)}><TerminalSquare size={15} /><span>{profile.name}</span>{!profile.available && <small>Not installed</small>}</button>)}
        <p>{!native ? 'Preview only. Run real shells in the desktop app.' : !root ? 'Starts immediately in your home folder.' : 'Starts immediately in your project folder.'}</p>
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
      <div className="settings-shortcuts"><Keyboard size={17} /><span>Ctrl+P · Find file<br />Ctrl+S · Save<br />Ctrl+F · Search in code<br />Ctrl+` · New terminal<br />F2 · Rename in explorer<br />Delete · Delete in explorer</span></div>
      <p className="subtle">Resetting the layout closes open terminal sessions. Files and editor changes are preserved.</p>
    </section></div>}
  </div>;
}
