import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Actions, BorderNode, DockLocation, Layout, Model, TabNode, TabSetNode, type Action, type IJsonModel } from 'flexlayout-react';
import { Blocks, ChevronDown, Code2, FileCode2, Files, Folder, FolderOpen, GitBranch, Keyboard, LayoutTemplate, Plus, Search, Settings2, TerminalSquare, X } from 'lucide-react';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { useTheme } from './theme';
import { loadShells, previewShells, type ShellProfile } from './shells';
import { loadSession, restoreFiles, saveSession, type Session } from './session';
import { loadProjects, rememberProject, sameProject } from './projects';
import Explorer, { FileDialog } from './Explorer';
import ContentSearch from './ContentSearch';
import { gitDecorations, GitDiff, GitPanel, useGitStatus, type GitChange } from './Git';
import WindowControls from './WindowControls';
import Problems from './Problems';
import { LanguageWorkspace, languageFeature, languageFeatures, languageId, type Definition, type LanguageFeature, type LanguageOptions, type Problem } from './language';
import type { EditorJump } from './Editor';
import { activateWorkspace, fileName, indexFiles, languageName, mutateEntry, native, pickWorkspace, readFile, withinEntry, writeFile, type FileEntry, type FileOperation, type OpenFile } from './workspace';

const LAYOUT_KEY = 'leve.layout.v1';
const LANGUAGE_KEY = 'leve.language-projects.v1';
type LanguagePreference = { path: string; options: LanguageOptions };
const defaultLanguageOptions: LanguageOptions = { python: false, typescript: false, javascript: false, eslint: false };
const featureKeys = Object.keys(languageFeatures) as LanguageFeature[];
function languageProjects(): LanguagePreference[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LANGUAGE_KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.flatMap(item => {
      if (typeof item === 'string') return [{ path: item, options: { python: true, typescript: true, javascript: true, eslint: true } }];
      if (!item || typeof item.path !== 'string' || !item.options) return [];
      const options = { ...defaultLanguageOptions };
      for (const feature of featureKeys) options[feature] = item.options[feature] === true;
      return [{ path: item.path, options }];
    });
  } catch { return []; }
}
const problemsTab = { type: 'tab', id: 'problems', name: 'Problems', component: 'problems', enableClose: false };
const gitTab = { type: 'tab', id: 'git', name: 'Git', component: 'git', enableClose: false };
const Editor = lazy(() => import('./Editor'));
const Terminal = lazy(() => import('./Terminal'));
function fileTab(model: Model, path: string): TabNode | undefined {
  let found: TabNode | undefined;
  model.visitNodes(node => { if (node instanceof TabNode && node.getComponent() === 'file' && node.getConfig()?.path === path) found = node; });
  return found;
}

function selectedFile(model: Model, previous: string): string {
  const active = model.getActiveTabset()?.getSelectedNode();
  if (active?.getComponent() === 'file') return active.getConfig().path;
  if (active?.getComponent() === 'git-diff') return '';

  // Clicking a utility panel keeps the selected editor as the active file.
  const previousTab = previous ? fileTab(model, previous) : undefined;
  const parent = previousTab?.getParent();
  if ((parent instanceof TabSetNode || parent instanceof BorderNode) && parent.getSelectedNode() === previousTab) return previous;

  const documents = model.getNodeById('documents');
  const document = documents instanceof TabSetNode ? documents.getSelectedNode() : undefined;
  return document?.getComponent() === 'file' ? document.getConfig().path : '';
}
const initialLayout = (): IJsonModel => ({
  global: { tabEnableRename: false, tabSetEnableClose: false, tabSetMinWidth: 170, tabSetMinHeight: 100, tabSetEnableMaximize: true },
  borders: [],
  layout: { type: 'row', weight: 100, children: [
    { type: 'tabset', id: 'navigation', weight: 20, enableDeleteWhenEmpty: false, children: [
      { type: 'tab', id: 'explorer', name: 'Explorer', component: 'explorer', enableClose: false },
      { type: 'tab', id: 'search', name: 'Search', component: 'search', enableClose: false },
      gitTab,
    ] },
    { type: 'row', weight: 80, children: [
      { type: 'tabset', id: 'documents', weight: 73, enableDeleteWhenEmpty: false, children: [
        { type: 'tab', id: 'welcome', name: 'Welcome', component: 'welcome', enableClose: false },
      ] },
      { type: 'tabset', id: 'terminals', weight: 27, enableDeleteWhenEmpty: false, children: [problemsTab] },
    ] },
  ] },
});

function loadLayout(savedLayout?: IJsonModel, restoredFiles?: Set<string>) {
  try {
    const raw = savedLayout ? JSON.stringify(savedLayout) : localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const json = JSON.parse(raw) as IJsonModel;
      // Restore validated file buffers and leave terminal sessions and diff views closed.
      const panelNames: Record<string, string> = { explorer: 'Explorer', search: 'Search', welcome: 'Welcome' };
      const clean = (node: { children?: any[]; component?: string; selected?: number; name?: string; config?: { path?: string } }) => {
        if (node.component && panelNames[node.component]) node.name = panelNames[node.component];
        if (node.children) node.children = node.children.filter(n => n.component !== 'terminal' && n.component !== 'git-diff' && (n.component !== 'file' || restoredFiles?.has(n.config?.path)));
        if (node.selected !== undefined) node.selected = 0;
        node.children?.forEach(clean);
      };
      clean(json.layout);
      const model = Model.fromJson(json);
      if (model.getNodeById('explorer') && model.getNodeById('search') && model.getNodeById('documents')) {
        if (!model.getNodeById('problems') && model.getNodeById('terminals')) {
          model.doAction(Actions.addNode(problemsTab, 'terminals', DockLocation.CENTER, 0));
        }
        const navigation = model.getNodeById('explorer')?.getParent();
        if (!model.getNodeById('git') && navigation) {
          model.doAction(Actions.addNode(gitTab, navigation.getId(), DockLocation.CENTER, -1, false));
        }
        return model;
      }
    }
  } catch { /* Fall back to the standard layout if stored data is incompatible. */ }
  return Model.fromJson(initialLayout());
}

export default function App() {
  const { theme, setTheme } = useTheme();
  const [model, setModel] = useState(loadLayout);
  const [root, setRoot] = useState<string | null>(null);
  const [enabledLanguageProjects, setEnabledLanguageProjects] = useState(languageProjects);
  const [problemsByFile, setProblemsByFile] = useState<Record<string, Problem[]>>({});
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(null);
  const fileOperationFocus = useRef<HTMLElement | null>(null);
  const [fileError, setFileError] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const fileBusyRef = useRef(false);
  const [reveal, setReveal] = useState('');
  const [files, setFiles] = useState<Record<string, OpenFile>>({});
  const filesRef = useRef(files); filesRef.current = files;
  const [refresh, setRefresh] = useState(0);
  const [gitRevision, setGitRevision] = useState(0);
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
  const [searchMode, setSearchMode] = useState<'files' | 'contents'>('files');
  const [jump, setJump] = useState<EditorJump | null>(null);
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
  const localRoot = native && root && !recoveryBlocked ? root : null;
  const refreshGit = useCallback(() => setGitRevision(value => value + 1), []);
  const gitProps = {
    root: localRoot,
    refresh: `${refresh}:${gitRevision}`,
    onRefresh: refreshGit,
  };
  const gitResult = useGitStatus(localRoot, gitProps.refresh);
  const decorations = useMemo(() => gitDecorations(gitResult?.data), [gitResult?.data]);
  useEffect(() => {
    if (!localRoot) return;
    window.addEventListener('focus', refreshGit);
    return () => window.removeEventListener('focus', refreshGit);
  }, [localRoot, refreshGit]);
  const languageOptions = enabledLanguageProjects.find(item => localRoot && sameProject(item.path, localRoot))?.options ?? defaultLanguageOptions;
  const languageWorkspace = useMemo(() => localRoot ? new LanguageWorkspace(localRoot, notify) : null, [localRoot, notify]);
  useEffect(() => () => languageWorkspace?.close(), [languageWorkspace]);
  useEffect(() => {
    if (!languageOptions.python) languageWorkspace?.stop('python');
    if (!languageOptions.typescript && !languageOptions.javascript) languageWorkspace?.stop('typescript');
  }, [languageOptions, languageWorkspace]);

  const toggleLanguageSupport = (feature: LanguageFeature, enabled: boolean) => {
    if (!root) return;
    const next = enabledLanguageProjects.filter(item => !sameProject(item.path, root));
    next.push({ path: root, options: { ...languageOptions, [feature]: enabled } });
    setEnabledLanguageProjects(next);
    try { localStorage.setItem(LANGUAGE_KEY, JSON.stringify(next)); } catch { /* The setting still works for this session. */ }
  };
  const reportProblems = useCallback((path: string, issues: Problem[]) => {
    setProblemsByFile(previous => {
      if (issues.length) return { ...previous, [path]: issues };
      if (!Object.hasOwn(previous, path)) return previous;
      const next = { ...previous };
      delete next[path];
      return next;
    });
  }, []);
  const problemsFile = activeFile && Object.hasOwn(files, activeFile) ? activeFile : '';
  const problems = useMemo(() => (problemsByFile[problemsFile] ?? [])
    .filter(problem => {
      if (problem.source === 'ESLint') return languageOptions.eslint;
      const feature = languageFeature(languageId(problem.path));
      return feature !== null && languageOptions[feature];
    })
    .sort((a, b) => a.line - b.line || a.column - b.column),
  [problemsByFile, problemsFile, languageOptions]);
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
          if (!fileTab(nextModel, file.path)) nextModel.doAction(Actions.addNode({ type: 'tab', id: `file:${file.path}`, name: file.name, component: 'file', config: { path: file.path } }, 'documents', DockLocation.CENTER, -1));
        }
        const selected = restored.files[saved.activeFile] ? saved.activeFile : Object.keys(restored.files)[0] || '';
        if (selected) nextModel.doAction(Actions.selectTab(fileTab(nextModel, selected)!.getId()));
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
    if (fileBusyRef.current) return;
    if (recoveryBlocked) { notify('Reopen the project before opening additional files.'); return; }
    const id = `file:${crypto.randomUUID()}`;
    const existing = fileTab(model, path);
    if (existing) { model.doAction(Actions.selectTab(existing.getId())); setActiveFile(path); return; }
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

  const openLocation = async (path: string, line: number, column: number) => {
    const currentGeneration = generation.current;
    await openFile(path);
    if (generation.current !== currentGeneration) return;
    setJump({ path, line, column, token: crypto.randomUUID() });
  };
  const goToDefinition = async (definition: Definition) => {
    if (!languageWorkspace) return;
    const currentGeneration = generation.current;
    const path = await languageWorkspace.resolve(definition.uri);
    if (generation.current === currentGeneration) await openLocation(path, definition.line + 1, definition.character + 1);
  };
  const showProblems = () => {
    if (model.getNodeById('problems')) model.doAction(Actions.selectTab('problems'));
    else model.doAction(Actions.addNode(problemsTab, model.getNodeById('terminals') ? 'terminals' : 'documents', DockLocation.CENTER, 0));
  };

  const saveFile = useCallback(async (path: string) => {
    if (fileBusyRef.current) return;
    if (recoveryBlocked) { notify('Reopen the original project before saving recovered changes to disk.'); return; }
    const file = filesRef.current[path];
    if (!file || file.content === file.saved || saving.current.has(path)) return;
    saving.current.add(path);
    const currentGeneration = generation.current;
    try {
      await writeFile(file);
      if (generation.current !== currentGeneration) return;
      setFiles(previous => previous[path] ? ({ ...previous, [path]: { ...previous[path], saved: file.content } }) : previous);
      refreshGit();
      notify(root ? `${file.name} saved.` : `${file.name} saved only in this demo session.`);
    } catch (error) { notify(`Could not save file: ${String(error)}`); }
    finally { saving.current.delete(path); }
  }, [notify, root, recoveryBlocked, refreshGit]);

  const applyFileOperation = async (name: string) => {
    if (!fileOperation || fileBusyRef.current) return;
    if (saving.current.size || opening.current.size) { setFileError('Wait for pending file operations to finish, then try again.'); return; }
    fileBusyRef.current = true; setFileBusy(true); setFileError('');
    try {
      const target = await mutateEntry(fileOperation, name, root);
      generation.current += 1;
      if ('entry' in fileOperation) {
        const source = fileOperation.entry.path;
        const updated = { ...filesRef.current };
        const affected = Object.keys(updated).filter(path => withinEntry(path, source));
        for (const path of affected) {
          const tab = fileTab(model, path);
          const file = updated[path]; delete updated[path];
          if (fileOperation.kind === 'rename') {
            const renamed = target + path.slice(source.length);
            updated[renamed] = { ...file, path: renamed, name: fileName(renamed) };
            if (tab) model.doAction(Actions.updateNodeAttributes(tab.getId(), { name: fileName(renamed), config: { path: renamed } }));
          } else if (tab) model.doAction(Actions.deleteTab(tab.getId()));
        }
        filesRef.current = updated; setFiles(updated);
        if (fileOperation.kind === 'rename' && withinEntry(activeFile, source)) setActiveFile(target + activeFile.slice(source.length));
      }
      setQuery(''); setMatches([]); setRefresh(value => value + 1); setReveal(target);
      setFileOperation(null);
      notify(fileOperation.kind === 'delete' ? 'Deleted permanently.' : fileOperation.kind === 'rename' ? 'Renamed. Unsaved edits were preserved.' : 'Created.');
      if (fileOperation.kind === 'file') {
        fileBusyRef.current = false;
        await openFile(target);
      }
    } catch (error) { setFileError(String(error)); setRefresh(value => value + 1); }
    finally { fileBusyRef.current = false; setFileBusy(false); }
  };

  const canDiscard = async () => {
    if (!Object.values(filesRef.current).some(file => file.content !== file.saved)) return true;
    const message = 'You have unsaved changes. Discard them?';
    return native ? confirmDialog(message, { title: 'Unsaved changes', kind: 'warning' }) : window.confirm(message);
  };

  const openFolder = async (recentPath?: string) => {
    if (fileBusyRef.current) return;
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
      setRoot(selected); setFiles({}); setActiveFile(''); setProblemsByFile({}); setQuery(''); setMatches([]);
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
        setSearchMode('files');
        event.preventDefault(); model.doAction(Actions.selectTab('search'));
        setTimeout(() => document.getElementById('file-search')?.focus(), 0);
      }
      if (event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); setSearchMode('contents'); model.doAction(Actions.selectTab('search'));
        setTimeout(() => document.getElementById('content-search')?.focus(), 0);
      }
      if (event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        showProblems();
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

  const openGitDiff = (change: GitChange) => {
    const name = `${fileName(change.path)} (Git diff)`;
    if (model.getNodeById('git-diff')) {
      model.doAction(Actions.updateNodeAttributes('git-diff', { name, config: { change } }));
      model.doAction(Actions.selectTab('git-diff'));
    } else {
      model.doAction(Actions.addNode({
        type: 'tab', id: 'git-diff', component: 'git-diff', enableDrag: false, name, config: { change },
      }, 'documents', DockLocation.CENTER, -1));
    }
  };

  const factory = (node: TabNode): ReactNode => {
    switch (node.getComponent()) {
      case 'explorer': return <Explorer root={root} blocked={!!recoveryBlocked} refresh={refresh} reveal={reveal} decorations={decorations} onRefresh={() => setRefresh(value => value + 1)} onOpen={path => void openFile(path)} onFolder={() => void openFolder()} onOperation={(operation, returnFocus) => {
        fileOperationFocus.current = returnFocus ?? null;
        setFileOperation(operation);
        setFileError('');
      }} />;
      case 'search': return <div className="search-panel panel-scroll"><div className="panel-heading">SEARCH</div>
        <div className="search-modes" role="tablist" aria-label="Search mode"><button role="tab" aria-selected={searchMode === 'files'} onClick={() => setSearchMode('files')}>Files</button><button role="tab" aria-selected={searchMode === 'contents'} onClick={() => setSearchMode('contents')}>Contents</button></div>
        {searchMode === 'contents' ? <ContentSearch root={root} blocked={!!recoveryBlocked || (native && !root)} refresh={refresh} onOpen={match => { void openFile(match.path).then(() => setJump({ ...match, token: crypto.randomUUID() })); }} /> : <>
        <label className="search-input"><Search size={14} /><input id="file-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="File name or path" /></label>
        <p className="panel-description">{searching ? 'Searching…' : query ? `${matches.length} result(s)` : 'Find files in your project. Use Ctrl+F to search within the code.'}</p>
        {matches.map(entry => <button className="search-result" key={entry.path} onClick={() => void openFile(entry.path)}><FileCode2 size={14} /><span>{entry.name}<small>{entry.path}</small></span></button>)}
        {query && <p className="panel-description">Up to 5,000 files · skips dependencies and build folders.</p>}
      </>}</div>;
      case 'git': return <GitPanel root={localRoot} onRefresh={refreshGit} result={gitResult} onOpen={openGitDiff} />;
      case 'git-diff': {
        const change: GitChange = node.getConfig().change;
        return <GitDiff key={`${change.kind}:${change.path}`} {...gitProps} change={change} />;
      }
      case 'file': {
        const file = files[node.getConfig().path];
        if (!file) return null;
        const feature = languageFeature(languageId(file.path));
        return <Suspense fallback={<p className="panel-description">Loading editor…</p>}><Editor file={file} jump={jump?.path === file.path ? jump : null}
          active={activeFile === file.path} languageWorkspace={languageWorkspace}
          lspEnabled={!!feature && languageOptions[feature]}
          lintEnabled={languageOptions.eslint && (feature === 'typescript' || feature === 'javascript')}
          onProblems={reportProblems} onDefinition={goToDefinition} onLanguageError={notify}
          onJumpError={() => notify('This search result no longer matches the open file. Save or reopen the file, then search again.')}
          onChange={(path, content) => setFiles(previous => ({ ...previous, [path]: { ...previous[path], content } }))}
          onSave={path => void saveFile(path)} onCursor={(line, col) => setPosition({ line, col })} /></Suspense>;
      }
      case 'problems': return <Problems key={problemsFile} file={problemsFile} problems={problems} onCopyStatus={notify} onOpen={problem => {
        void openLocation(problem.path, problem.line, problem.column);
      }} />;
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

  const navigationSelected = (id: string) => {
    const tab = model.getNodeById(id);
    const parent = tab?.getParent();
    return (parent instanceof TabSetNode || parent instanceof BorderNode) && parent.getSelectedNode() === tab;
  };
  const gitSelected = navigationSelected('git');
  useEffect(() => {
    if (gitSelected) refreshGit();
  }, [gitSelected, refreshGit]);

  return <div className="app-shell" onContextMenuCapture={event => event.preventDefault()}>
    <header className={native ? 'titlebar desktop-titlebar' : 'titlebar'} data-tauri-drag-region={native ? '' : undefined}>
      <div className="app-name"><Code2 size={18} /><strong>leve</strong><span className="preview-tag">preview</span></div>
      <button ref={projectPicker} className="project-picker" data-tauri-drag-region="false" title={root || 'Switch project'} aria-haspopup="menu" aria-expanded={projectMenu} aria-controls={projectMenu ? 'project-menu' : undefined} disabled={switchingProject} onClick={() => setProjectMenu(value => !value)}><Folder size={13} /><span>{root ? fileName(root) : 'No folder open'}</span><ChevronDown size={12} /></button>
      <div className="titlebar-actions" data-tauri-drag-region="false">
        <button className="icon-button" title="Layout and shortcuts" onClick={() => setSettings(true)}><Settings2 size={16} /></button>
        {native && <WindowControls report={notify} />}
      </div>
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
      <button title="Explorer" className="activity-button" aria-pressed={navigationSelected('explorer')} onClick={() => model.doAction(Actions.selectTab('explorer'))}><Files size={19} /></button>
      <button title="Find files (Ctrl+P)" className="activity-button" aria-pressed={navigationSelected('search')} onClick={() => { model.doAction(Actions.selectTab('search')); setTimeout(() => document.getElementById('file-search')?.focus(), 0); }}><Search size={19} /></button>
      <button title="Git changes" className="activity-button" aria-pressed={gitSelected} onClick={() => model.doAction(Actions.selectTab('git'))}><GitBranch size={19} /></button>
      <button title="New terminal" className="activity-button" onClick={openTerminalMenu}><TerminalSquare size={21} /></button>
      <div className="activity-spacer" /><button title="Settings" className="activity-button" onClick={() => setSettings(true)}><Settings2 size={21} /></button>
    </aside><main className="layout-host"><Layout model={model} factory={factory} onAction={onAction}
      onModelChange={current => {
        persist(current);
        setLayoutVersion(value => value + 1);
        setActiveFile(previous => selectedFile(current, previous));
      }}
      onRenderTab={(node, values) => {
        if (node.getComponent() === 'problems') {
          values.content = <span className="problems-tab-label">Problems <span className="problems-count">{problems.length}</span></span>;
          return;
        }
        const path = node.getConfig()?.path;
        const dirty = path && files[path]?.content !== files[path]?.saved;
        if (dirty) values.content = <span>{node.getName()}<span className="dirty-dot" title="Unsaved changes">●</span></span>;
      }}
      onRenderTabSet={(node, values) => { if (node.getId() === 'terminals') values.buttons.push(<button key="new" className="icon-button" title="New terminal" aria-haspopup="menu" onClick={openTerminalMenu}><Plus size={14} /></button>); }}
    /></main></div>
    <footer className="statusbar"><span className="status-indicator" />{native ? 'Local' : 'Web preview'}<span className="status-divider" /><span>{root ? fileName(root) : 'Demo project'}</span><div className="status-spacer" /><span title={checkpointTime ? `Last recovery checkpoint: ${checkpointTime}` : 'Preparing recovery'}>{recoveryError || recoveryLocked ? 'Recovery unavailable' : checkpointTime ? 'Recovery saved' : 'Recovery pending'}</span><span>Ln {position.line}, Col {position.col}</span><span>UTF-8</span><span>{activeFile ? languageName(activeFile) : 'Leve'}</span></footer>
    {(!sessionReady || closing) && <div className="session-loading" role="status">{closing ? 'Saving session…' : 'Restoring session…'}</div>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {fileOperation && <FileDialog key={JSON.stringify(fileOperation)} operation={fileOperation} dirtyCount={'entry' in fileOperation ? Object.values(files).filter(file => withinEntry(file.path, fileOperation.entry.path) && file.content !== file.saved).length : 0} busy={fileBusy} error={fileError} onCancel={() => {
      if (fileBusy) return;
      setFileOperation(null);
      const returnFocus = fileOperationFocus.current;
      requestAnimationFrame(() => returnFocus?.focus());
    }} onSubmit={name => void applyFileOperation(name)} />}
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
      <fieldset className="language-settings">
        <legend>Language support</legend>
        <div className="language-options">{featureKeys.map(feature => <label key={feature}>
          <input type="checkbox" checked={languageOptions[feature]} disabled={!languageWorkspace} onChange={event => toggleLanguageSupport(feature, event.target.checked)} />
          {languageFeatures[feature]}
        </label>)}</div>
        <p>Options apply to the open project. ESLint uses the project's installation and checks the active JavaScript or TypeScript file as you edit.</p>
        <p>Enable only for projects you trust. Analysis tools can run project configuration and plugins.</p>
        <p><kbd>Ctrl+Space</kbd> Complete <kbd>F12</kbd> Go to Definition <kbd>Ctrl+Shift+M</kbd> Diagnostics</p>
      </fieldset>
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
      <p className="subtle">Ctrl+Shift+F · Search project contents</p>
      <p className="subtle">Resetting the layout closes open terminal sessions. Files and editor changes are preserved.</p>
    </section></div>}
  </div>;
}
