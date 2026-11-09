import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Actions, BorderNode, DockLocation, Layout, Model, PopupMenu, TabNode, TabSetNode, type Action, type IJsonModel } from 'flexlayout-react';
import { Blocks, Check, ChevronDown, Code2, FileCode2, Files, Folder, FolderOpen, GitBranch, LayoutTemplate, PanelLeft, PanelLeftClose, Plus, Search, Settings2, TerminalSquare, X } from 'lucide-react';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { loadShells, previewShells, type ShellProfile } from './shells';
import { loadSession, restoreFiles, saveSession, type Session } from './session';
import { loadProjects, rememberProject, sameProject } from './projects';
import { version } from '../package.json';
import Explorer, { FileDialog, type FileDialogOperation } from './Explorer';
import { loadExplorerPreferences, saveExplorerPreferences } from './explorerPreferences';
import { indentSizes, loadEditorPreferences, saveEditorPreferences } from './editorPreferences';
import { resolveIndentation, useEditorConfigs } from './editorConfig';
import { applyTextChanges, convertLineEndings, lineEndingLabel, preferredLineEnding } from './lineEndings';
import { convertEncoding, textEncoding, type TextEncoding } from './textEncoding';
import ContentSearch from './ContentSearch';
import ImagePreview from './ImagePreview';
import { gitDecorations, GitCommitView, GitDiff, GitPanel, useGitStatus, type GitChange, type GitCommitSelection } from './Git';
import WindowControls from './WindowControls';
import Problems from './Problems';
import SettingsDialog, { type SettingsSection } from './SettingsDialog';
import { dockPanel, documentTabset, getTab, hiddenPanelsBorder, hidePanels, isPanelShown, navigationPanelIds, panelIds, panelTabs, restorePanelSizes, revealTab, tabsetOf, terminalTabs, terminalTabset, type PanelId } from './dockPanels';
import { LanguageWorkspace, languageFeature, languageFeatures, languageId, type Definition, type LanguageFeature, type LanguageOptions, type Problem } from './language';
import type { EditorHandle, EditorJump } from './Editor';
import { activateWorkspace, fileName, indexFiles, isImagePath, languageName, mutateEntry, native, pickWorkspace, readFile, saveFileAs, withinEntry, writeFile, type FileEntry, type OpenFile } from './workspace';

const LAYOUT_KEY = 'leve.layout.v1';
const LANGUAGE_KEY = 'leve.language-projects.v1';
const titleMenuNames = ['File', 'Edit', 'View', 'Settings'] as const;
const hasUnsavedText = (file: OpenFile) => !file.image && file.content !== file.saved;
const workspaceMenuClassName = (name: string) => `${name} ${name.replace('flexlayout__', 'workspace-menu-')}`;
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

  const document = documentTabset(model)?.getSelectedNode();
  return document?.getComponent() === 'file' ? document.getConfig().path : '';
}
// FlexLayout only removes empty tabsets that are closeable. Hide the group close button separately.
const tabsetCleanup = { tabSetEnableClose: true, tabSetEnableCloseButton: false, tabSetEnableDeleteWhenEmpty: true };
const initialLayout = (): IJsonModel => ({
  global: { ...tabsetCleanup, tabEnableRename: false, tabSetMinWidth: 170, tabSetMinHeight: 100, tabSetEnableMaximize: true },
  borders: [hiddenPanelsBorder()],
  layout: { type: 'row', weight: 100, children: [
    { type: 'tabset', id: 'navigation', weight: 20, children: [
      panelTabs.explorer, panelTabs.search, panelTabs.git,
    ] },
    { type: 'row', weight: 80, children: [
      { type: 'tabset', id: 'documents', weight: 73, children: [
        { type: 'tab', id: 'welcome', name: 'Welcome', component: 'welcome', enableClose: false },
      ] },
      { type: 'tabset', id: 'terminals', weight: 27, children: [panelTabs.problems] },
    ] },
  ] },
});

function loadLayout(savedLayout?: IJsonModel, restoredFiles?: Set<string>) {
  try {
    const raw = savedLayout ? JSON.stringify(savedLayout) : localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const json = JSON.parse(raw) as IJsonModel;
      json.global = { ...json.global, ...tabsetCleanup };
      // Restore validated file buffers and leave terminal sessions and diff views closed.
      const panelNames: Record<string, string> = { explorer: 'Explorer', search: 'Search', welcome: 'Welcome' };
      const clean = (node: { type?: string; children?: any[]; component?: string; selected?: number; name?: string; enableDeleteWhenEmpty?: boolean }) => {
        if (node.type === 'tabset') delete node.enableDeleteWhenEmpty;
        if (node.component && panelNames[node.component]) node.name = panelNames[node.component];
        if (node.children) node.children = node.children.filter(n => n.component !== 'terminal' && n.component !== 'git-diff' && (n.component !== 'file' || restoredFiles?.has(n.config?.path)));
        if (node.selected !== undefined) node.selected = 0;
        node.children?.forEach(clean);
      };
      clean(json.layout);
      json.borders ??= [];
      if (!json.borders.some(border => border.location === 'left')) json.borders.push(hiddenPanelsBorder());
      json.borders.forEach(clean);
      const model = Model.fromJson(json);
      if (model.getNodeById('explorer') && model.getNodeById('search') && documentTabset(model)) {
        if (!model.getNodeById('problems') && model.getNodeById('terminals')) {
          model.doAction(Actions.addNode(panelTabs.problems, 'terminals', DockLocation.CENTER, 0));
        }
        const navigation = tabsetOf(getTab(model, 'explorer')) ?? tabsetOf(getTab(model, 'search'));
        if (!model.getNodeById('git') && navigation) {
          model.doAction(Actions.addNode(panelTabs.git, navigation.getId(), DockLocation.CENTER, -1, false));
        }
        return model;
      }
    }
  } catch { /* Fall back to the standard layout if stored data is incompatible. */ }
  return Model.fromJson(initialLayout());
}

export default function App() {
  const [model, setModel] = useState(loadLayout);
  const [root, setRoot] = useState<string | null>(null);
  const [enabledLanguageProjects, setEnabledLanguageProjects] = useState(languageProjects);
  const [problemsByFile, setProblemsByFile] = useState<Record<string, Problem[]>>({});
  const [fileOperation, setFileOperation] = useState<FileDialogOperation | null>(null);
  const fileOperationFocus = useRef<HTMLElement | null>(null);
  const [fileError, setFileError] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const fileBusyRef = useRef(false);
  const [reveal, setReveal] = useState('');
  const [files, setFiles] = useState<Record<string, OpenFile>>({});
  const filesRef = useRef(files); filesRef.current = files;
  const [refresh, setRefresh] = useState(0);
  const [gitRevision, setGitRevision] = useState(0);
  const [branchOperation, setBranchOperation] = useState<'switch' | 'pull' | null>(null);
  const switchingBranch = branchOperation !== null;
  const branchBusy = useRef(false);
  const [bufferVersions, setBufferVersions] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<{ message: string; persistent: boolean } | null>(null);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [explorerPreferences, setExplorerPreferences] = useState(loadExplorerPreferences);
  useEffect(() => saveExplorerPreferences(explorerPreferences), [explorerPreferences]);
  const [editorPreferences, setEditorPreferences] = useState(loadEditorPreferences);
  useEffect(() => saveEditorPreferences(editorPreferences), [editorPreferences]);
  const [projects, setProjects] = useState(loadProjects);
  const [projectMenu, setProjectMenu] = useState(false);
  const [titleMenu, setTitleMenu] = useState<{ name: (typeof titleMenuNames)[number]; origin: HTMLButtonElement } | null>(null);
  const activeEditor = useRef<EditorHandle | null>(null);
  const [encodingMenu, setEncodingMenu] = useState<{ path: string; origin: HTMLButtonElement } | null>(null);
  const appShell = useRef<HTMLDivElement>(null);
  const [switchingProject, setSwitchingProject] = useState(false);
  const projectPicker = useRef<HTMLButtonElement>(null);
  const [profiles, setProfiles] = useState<ShellProfile[]>(native ? [] : previewShells);
  const [terminalMenu, setTerminalMenu] = useState<{ left: number; top: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tab: TabNode; anchor: { x: number; y: number } | HTMLElement; origin: HTMLElement } | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<'files' | 'contents'>('files');
  const [jump, setJump] = useState<EditorJump | null>(null);
  const [position, setPosition] = useState({ line: 1, col: 1 });
  const [activeFile, setActiveFile] = useState('');
  const activeDocument = Object.hasOwn(files, activeFile) ? files[activeFile] : undefined;
  const activeImage = activeDocument?.image === true;
  const activeContent = activeDocument?.content ?? '';
  const activeLineEnding = activeDocument?.lineEnding;
  const lineEndings = useMemo(() => lineEndingLabel(activeContent, activeLineEnding), [activeContent, activeLineEnding]);
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
  const opening = useRef(new Set<string>());
  const saving = useRef(new Set<string>());
  const generation = useRef(0);
  const fileIndex = useRef<Promise<FileEntry[]> | null>(null);

  const notify = useCallback((message: string, persistent = false) => setNotice({ message, persistent }), []);
  const localRoot = native && root && !recoveryBlocked ? root : null;
  const editorConfigs = useEditorConfigs(editorPreferences.useEditorConfig ? localRoot : null, JSON.stringify(Object.values(files).filter(file => !file.image).map(file => file.path)), `${refresh}:${gitRevision}`);
  const activeIndentation = resolveIndentation(editorPreferences, editorConfigs?.get(activeFile));
  const automaticIndentationLabel = `Auto · ${activeIndentation.indentStyle === 'tabs' ? 'Tabs' : 'Spaces'}: ${activeIndentation.indentSize}`;
  const refreshGit = useCallback(() => setGitRevision(value => value + 1), []);
  const gitProps = {
    root: localRoot,
    refresh: `${refresh}:${gitRevision}`,
    onRefresh: refreshGit,
  };
  const gitResult = useGitStatus(localRoot, gitProps.refresh);
  const decorations = useMemo(() => gitDecorations(gitResult?.data?.flatMap(repo => repo.changes)), [gitResult?.data]);
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
  const problemsFile = !activeImage && Object.hasOwn(files, activeFile) ? activeFile : '';
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
        const target = documentTabset(nextModel)!;
        for (const file of Object.values(restored.files)) {
          if (!fileTab(nextModel, file.path)) nextModel.doAction(Actions.addNode({ type: 'tab', id: `file:${file.path}`, name: file.name, component: 'file', config: { path: file.path } }, target.getId(), DockLocation.CENTER, -1));
        }
        const selected = restored.files[saved.activeFile] ? saved.activeFile : Object.keys(restored.files)[0] || '';
        if (selected) revealTab(nextModel, fileTab(nextModel, selected)!);
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
  useEffect(() => { if (notice && !notice.persistent) { const timer = setTimeout(() => setNotice(null), 6500); return () => clearTimeout(timer); } }, [notice]);

  const persist = (current: Model) => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(current.toJson())); } catch { /* Storage can be unavailable in private mode. */ }
  };

  const openFile = useCallback(async (path: string) => {
    if (fileBusyRef.current) return;
    if (recoveryBlocked) { notify('Reopen the project before opening additional files.'); return; }
    const id = `file:${crypto.randomUUID()}`;
    const existing = fileTab(model, path);
    if (existing) { revealTab(model, existing); setActiveFile(path); return; }
    if (opening.current.has(path)) return;
    opening.current.add(path);
    const currentGeneration = generation.current;
    try {
      const name = fileName(path);
      const image = isImagePath(path);
      const content = image ? '' : await readFile(path);
      if (generation.current !== currentGeneration) return;
      const file: OpenFile = { path, name, content, saved: content, ...(image ? { image: true } : {}) };
      setFiles(previous => ({ ...previous, [path]: file }));
      const target = documentTabset(model);
      if (target) {
        model.doAction(Actions.addNode({ type: 'tab', id, name, component: 'file', config: { path } }, target.getId(), DockLocation.CENTER, -1));
        const opened = getTab(model, id);
        if (opened && !isPanelShown(model, opened)) revealTab(model, opened);
      }
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
  const showPanel = (id: PanelId) => dockPanel(model, getTab(model, id) ?? panelTabs[id]);

  const persistFile = useCallback(async (file: OpenFile, content: string, encoding?: TextEncoding) => {
    const currentGeneration = generation.current;
    await writeFile({ ...file, content });
    if (generation.current !== currentGeneration) return false;
    setFiles(previous => {
      if (!Object.hasOwn(previous, file.path)) return previous;
      const current = previous[file.path];
      const currentContent = encoding ? convertEncoding(current.content, encoding) ?? current.content : current.content;
      return { ...previous, [file.path]: { ...current, saved: content, content: currentContent } };
    });
    return true;
  }, []);

  const saveFile = useCallback(async (path: string, encoding?: TextEncoding) => {
    if (fileBusyRef.current) return;
    if (recoveryBlocked) { notify('Reopen the original project before saving recovered changes to disk.'); return; }
    const file = filesRef.current[path];
    if (!file || file.image || saving.current.has(path)) return;
    const content = encoding ? convertEncoding(file.content, encoding) : file.content;
    if (content === null) { notify('This file starts with a U+FEFF character that requires a BOM to preserve it.'); return; }
    if (content === file.saved && content === file.content) return;
    saving.current.add(path);
    try {
      if (!await persistFile(file, content, encoding)) return;
      refreshGit();
      notify(root ? `${file.name} saved.` : `${file.name} saved only in this demo session.`);
    } catch (error) { notify(`Could not save file: ${String(error)}`); }
    finally { saving.current.delete(path); }
  }, [notify, root, recoveryBlocked, refreshGit, persistFile]);

  const canSaveAll = !fileBusy && !switchingProject && !closing && !recoveryBlocked && Object.values(files).some(hasUnsavedText);
  const saveAll = async () => {
    if (fileBusyRef.current || switchingProject || closing || recoveryBlocked) return;
    if (saving.current.size) { notify('Wait for the current save to finish, then try Save All again.'); return; }
    const pending = Object.values(filesRef.current).filter(hasUnsavedText);
    if (!pending.length) return;
    fileBusyRef.current = true;
    setFileBusy(true);
    const failures: string[] = [];
    let saved = 0;
    try {
      for (const file of pending) {
        try { if (await persistFile(file, file.content)) saved++; }
        catch (error) { failures.push(`${file.path} — ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (saved) refreshGit();
      const summary = `Saved ${saved} ${saved === 1 ? 'file' : 'files'}${root ? '.' : ' in this demo session.'}`;
      notify(failures.length ? `${summary}\nCould not save ${failures.length} ${failures.length === 1 ? 'file' : 'files'}.\n${failures.join('\n')}` : summary, failures.length > 0);
    } finally { fileBusyRef.current = false; setFileBusy(false); }
  };

  const reopenTextFile = async (path: string) => {
    const file = Object.hasOwn(filesRef.current, path) ? filesRef.current[path] : undefined;
    if (!file || file.image || fileBusyRef.current || saving.current.has(path) || recoveryBlocked || switchingProject || closing) return;
    fileBusyRef.current = true;
    setFileBusy(true);
    try {
      if (file.content !== file.saved) {
        const message = `Discard unsaved changes and reopen ${file.name}?`;
        if (!(native ? await confirmDialog(message, { title: 'Reopen file', kind: 'warning' }) : window.confirm(message))) return;
      }
      const content = await readFile(path);
      if (filesRef.current[path] !== file) throw new Error('The open file changed. Try again.');
      const updated = { ...filesRef.current, [path]: { ...file, content, saved: content, lineEnding: undefined } };
      filesRef.current = updated;
      setFiles(updated);
      setBufferVersions(previous => ({ ...previous, [path]: (previous[path] ?? 0) + 1 }));
      setJump(null);
      refreshGit();
      notify(`${file.name} reopened as ${textEncoding(content)}.`);
    } catch (error) { notify(`Could not reopen file: ${String(error)}`); }
    finally { fileBusyRef.current = false; setFileBusy(false); }
  };

  const canSaveAs = !!activeFile && !activeImage && !recoveryBlocked && !switchingProject && !closing;
  const openSaveAs = (path = activeFile, kind: 'saveAs' | 'saveCopyAs' = 'saveAs') => {
    const file = Object.hasOwn(filesRef.current, path) ? filesRef.current[path] : undefined;
    if (!file || file.image || recoveryBlocked || switchingProject || closing || fileOperation || fileBusyRef.current) return;
    fileOperationFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFileError('');
    setFileOperation({ kind, path });
  };

  const applySaveAs = async (source: string, target: string, copy: boolean) => {
    const file = Object.hasOwn(filesRef.current, source) ? filesRef.current[source] : undefined;
    const tab = fileTab(model, source);
    if (!file || file.image || !tab) throw new Error('The source file is no longer open.');
    if (isImagePath(target)) throw new Error('Choose a text file extension.');
    if (Object.keys(filesRef.current).some(path => path.toLowerCase() === target.toLowerCase())) {
      throw new Error('Choose a destination that is not already open.');
    }
    const result = await saveFileAs(target, file.content, root);
    if (result.status === 'exists') {
      const message = `Replace ${target}?`;
      const accepted = native ? await confirmDialog(message, { title: 'Replace file', kind: 'warning' }) : window.confirm(message);
      if (!accepted) return;
      await saveFileAs(target, file.content, root, result.expected);
    }
    setRefresh(value => value + 1);
    setFileOperation(null);
    if (copy) {
      notify(`Copy saved as ${target}${root ? '.' : ' in this demo session.'}`);
      requestAnimationFrame(() => fileOperationFocus.current?.focus());
      return;
    }
    const name = fileName(target);
    const updated = { ...filesRef.current, [target]: { ...file, path: target, name, saved: file.content } };
    delete updated[source];
    filesRef.current = updated;
    setFiles(updated);
    model.doAction(Actions.updateNodeAttributes(tab.getId(), { name, config: { path: target } }));
    setActiveFile(target);
    setJump(null);
    setReveal(target);
    notify(`${name} saved${root ? '.' : ' only in this demo session.'}`);
  };

  const updateGitWorktree = async (repo: string, operation: 'switch' | 'pull', run: (root: string) => Promise<unknown>) => {
    if (!localRoot || switchingProject || closing || fileBusyRef.current || saving.current.size || opening.current.size) {
      throw new Error('Wait for pending project or file operations to finish, then try again.');
    }
    if (Object.values(filesRef.current).some(file => file.content !== file.saved)) {
      throw new Error(operation === 'pull' ? 'Save your open edits before pulling.' : 'Save your open edits before switching branches.');
    }
    fileBusyRef.current = true;
    branchBusy.current = true;
    setBranchOperation(operation);
    try {
      try {
        await run(localRoot);
      } finally {
        // A Git hook may fail after the working tree has already changed.
        const affected = Object.values(filesRef.current).filter(file => !repo || withinEntry(file.path, repo));
        const reloaded = await Promise.all(affected.map(async file => {
          if (file.image) return { file, content: file.content };
          try { return { file, content: await readFile(file.path) }; }
          catch { return { file, content: null }; }
        }));
        const updated = { ...filesRef.current };
        const remount: string[] = [];
        const closed: string[] = [];
        for (const { file, content } of reloaded) {
          const current = Object.hasOwn(updated, file.path) ? updated[file.path] : undefined;
          if (!current || current.content !== current.saved) continue;
          if (content === null) {
            delete updated[file.path];
            closed.push(file.path);
          } else if (file.image || content !== file.content) {
            updated[file.path] = { ...current, content, saved: content, lineEnding: undefined };
            remount.push(file.path);
          }
        }
        filesRef.current = updated;
        setFiles(updated);
        setBufferVersions(previous => ({ ...previous, ...Object.fromEntries(remount.map(path => [path, (previous[path] ?? 0) + 1])) }));
        for (const path of closed) {
          const tab = fileTab(model, path);
          if (tab) model.doAction(Actions.deleteTab(tab.getId()));
        }
        setJump(null);
        setMatches([]);
        setRefresh(value => value + 1);
        if (closed.length) notify(`Closed ${closed.length} file tab(s) that could not be reopened after the Git operation.`);
      }
    } finally {
      branchBusy.current = false;
      fileBusyRef.current = false;
      setBranchOperation(null);
    }
  };

  const applyFileOperation = async (name: string) => {
    if (!fileOperation || fileBusyRef.current) return;
    if (saving.current.size || opening.current.size) { setFileError('Wait for pending file operations to finish, then try again.'); return; }
    fileBusyRef.current = true; setFileBusy(true); setFileError('');
    try {
      if ('path' in fileOperation) {
        await applySaveAs(fileOperation.path, name.replaceAll('\\', '/'), fileOperation.kind === 'saveCopyAs');
        return;
      }
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
      setBufferVersions({});
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
    dockPanel(model, { type: 'tab', id, name: profile.name, component: 'terminal', config: { shellId } });
    setTerminalMenu(null);
  };

  const showTerminalMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setTerminalMenu({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)), top: rect.bottom + 240 < window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - 240) });
    void loadShells().then(setProfiles).catch(error => notify(`Could not detect shells: ${String(error)}`));
  };
  const openTerminalMenu = (event: MouseEvent<HTMLButtonElement>) => showTerminalMenu(event.currentTarget);

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
        if (fileBusyRef.current) return;
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
      if (settings || fileOperation || branchBusy.current) return;
      if (event.key === 'Escape') { setTerminalMenu(null); setProjectMenu(false); if (projectMenu) projectPicker.current?.focus(); }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') {
        if (event.altKey) return;
        event.preventDefault();
        if (event.shiftKey) openSaveAs();
        else if (activeFile && !activeImage) void saveFile(activeFile);
      }
      if (event.key.toLowerCase() === 'p') {
        setSearchMode('files');
        event.preventDefault(); showPanel('search');
        setTimeout(() => document.getElementById('file-search')?.focus(), 0);
      }
      if (event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); setSearchMode('contents'); showPanel('search');
        setTimeout(() => document.getElementById('content-search')?.focus(), 0);
      }
      if (event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        showPanel('problems');
      }
      if (event.key === '`') { event.preventDefault(); addTerminal(); }
    };
    const handleSaveAll = (event: KeyboardEvent) => {
      if (settings || fileOperation || !(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey || event.getModifierState('AltGraph') || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      event.stopPropagation();
      void saveAll();
    };
    window.addEventListener('keydown', handleSaveAll, true);
    window.addEventListener('keydown', handle);
    return () => {
      window.removeEventListener('keydown', handleSaveAll, true);
      window.removeEventListener('keydown', handle);
    };
  });

  const onAction = (action: Action) => {
    if (branchBusy.current) return undefined;
    if (action.type !== Actions.DELETE_TAB) return action;
    if (fileBusyRef.current) return undefined;
    const tab = model.getNodeById(action.data.node);
    if (!(tab instanceof TabNode) || !tab.isCloseable()) return undefined;
    const path = tab.getConfig()?.path;
    const forgetFile = () => {
      if (path) setFiles(previous => { const next = { ...previous }; delete next[path]; return next; });
    };
    const file = filesRef.current[path];
    if (file && file.content !== file.saved) {
      const message = `Discard changes to ${file.name}?`;
      void (native ? confirmDialog(message, { title: 'Close file', kind: 'warning' }) : Promise.resolve(window.confirm(message))).then(accepted => {
        if (accepted && sessionRef.current.model === model && model.getNodeById(tab.getId()) === tab) {
          model.doAction(action);
          forgetFile();
        }
      });
      return undefined;
    }
    forgetFile();
    return action;
  };

  const closeTab = (tab: TabNode) => {
    const action = onAction(Actions.deleteTab(tab.getId()));
    if (action) model.doAction(action);
  };

  const openGitView = (name: string, config: { change: GitChange } | { selection: GitCommitSelection }) => {
    if (getTab(model, 'git-diff')) {
      model.doAction(Actions.updateNodeAttributes('git-diff', { name, config }));
    } else {
      const target = documentTabset(model);
      if (target) model.doAction(Actions.addNode({
        type: 'tab', id: 'git-diff', component: 'git-diff', enableDrag: false, name, config,
      }, target.getId(), DockLocation.CENTER, -1));
    }
    const tab = getTab(model, 'git-diff');
    if (tab) revealTab(model, tab);
  };

  const factory = (node: TabNode): ReactNode => {
    switch (node.getComponent()) {
      case 'explorer': return <Explorer root={root} blocked={!!recoveryBlocked} visible={node.isSelected() && isPanelShown(model, node)} refresh={refresh} reveal={reveal} decorations={decorations} preferences={explorerPreferences} onRefresh={() => setRefresh(value => value + 1)} onOpen={path => void openFile(path)} onFolder={() => void openFolder()} onOperation={(operation, returnFocus) => {
        fileOperationFocus.current = returnFocus ?? null;
        setFileOperation(operation);
        setFileError('');
      }} />;
      case 'search': {
        const heading = <>
          <div className="panel-heading">SEARCH</div>
          <div className="search-modes" role="tablist" aria-label="Search mode"><button role="tab" aria-selected={searchMode === 'files'} onClick={() => setSearchMode('files')}>Files</button><button role="tab" aria-selected={searchMode === 'contents'} onClick={() => setSearchMode('contents')}>Contents</button></div>
        </>;
        return <div className="search-panel panel-layout">
          {searchMode === 'contents' ? <ContentSearch heading={heading} root={root} blocked={!!recoveryBlocked || (native && !root)} refresh={refresh} onOpen={match => { void openFile(match.path).then(() => setJump({ ...match, token: crypto.randomUUID() })); }} /> : <>
            <div className="panel-toolbar search-tools">
              {heading}
              <label className="search-input"><Search size={14} /><input id="file-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="File name or path" /></label>
            </div>
            <div className="panel-body">
              <p className="panel-description">{searching ? 'Searching…' : query ? `${matches.length} result(s)` : 'Find files in your project. Use Ctrl+F to search within the code.'}</p>
              {matches.map(entry => <button className="search-result" key={entry.path} onClick={() => void openFile(entry.path)}><FileCode2 size={14} /><span>{entry.name}<small>{entry.path}</small></span></button>)}
              {query && <p className="panel-description">Up to 5,000 files · skips dependencies and build folders.</p>}
            </div>
          </>}
        </div>;
      }
      case 'git': return <GitPanel key={localRoot} {...gitProps} result={gitResult}
        onSwitch={(repo, branch) => updateGitWorktree(repo, 'switch', expectedRoot => invoke('git_switch', { expectedRoot, repo, branch }))}
        onPull={(repo, request) => updateGitWorktree(repo, 'pull', expectedRoot => invoke('git_receive', { expectedRoot, repo, request: { operation: 'pull', ...request } }))}
        onOpen={change => openGitView(`${fileName(change.path)} (Git diff)`, { change })}
        onCommit={selection => openGitView(`${selection.commit.id.slice(0, 7)} (Git commit)`, { selection })} />;
      case 'git-diff': {
        const config = node.getConfig() as { change: GitChange } | { selection: GitCommitSelection };
        if ('selection' in config) return <GitCommitView key={JSON.stringify([config.selection.repo, config.selection.commit.id])} {...gitProps} selection={config.selection} />;
        const { change } = config;
        const available = gitResult?.data?.some(repo => repo.changes.some(item => item.kind === change.kind && item.path === change.path));
        return <GitDiff key={`${change.kind}:${change.path}`} {...gitProps} change={change} available={available} />;
      }
      case 'file': {
        const file = files[node.getConfig().path];
        if (!file) return null;
        const bufferKey = `${file.path}:${bufferVersions[file.path] ?? 0}`;
        if (file.image) return recoveryBlocked
          ? <p className="panel-description">Reopen the project to preview this image.</p>
          : <ImagePreview key={bufferKey} path={file.path} name={file.name} root={root} />;
        const feature = languageFeature(languageId(file.path));
        return <Suspense fallback={<p className="panel-description">Loading editor…</p>}><Editor key={bufferKey} ref={activeFile === file.path ? activeEditor : undefined} file={file} jump={jump?.path === file.path ? jump : null}
          active={activeFile === file.path} preferences={{ ...editorPreferences, ...(file.indentation ?? resolveIndentation(editorPreferences, editorConfigs?.get(file.path))) }} languageWorkspace={languageWorkspace}
          lspEnabled={!!feature && languageOptions[feature]}
          lintEnabled={languageOptions.eslint && (feature === 'typescript' || feature === 'javascript')}
          onProblems={reportProblems} onDefinition={goToDefinition} onLanguageError={notify}
          onJumpError={() => notify('This search result no longer matches the open file. Save or reopen the file, then search again.')}
          onChange={(path, changes) => setFiles(previous => {
            if (!Object.hasOwn(previous, path)) return previous;
            const file = previous[path];
            const lineEnding = file.lineEnding ?? preferredLineEnding(file.content);
            const content = applyTextChanges(file.content, changes, lineEnding);
            return { ...previous, [path]: { ...file, content, lineEnding } };
          })}
          onSave={path => void saveFile(path)} onSaveAs={openSaveAs} onCursor={(line, col) => setPosition({ line, col })} /></Suspense>;
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
      </div><span className="welcome-version">{native ? `LEVE EDITOR · V${version}` : 'LEVE EDITOR · WEB PREVIEW'}</span></div>;
    }
  };

  const navigationSelected = (id: string) => {
    const tab = getTab(model, id);
    return !!tab && isPanelShown(model, tab) && tab.isSelected();
  };
  const gitSelected = navigationSelected('git');
  useEffect(() => {
    if (gitSelected) refreshGit();
  }, [gitSelected, refreshGit]);

  const togglePanel = (id: PanelId) => {
    const tab = getTab(model, id);
    if (tab && isPanelShown(model, tab)) hidePanels(model, [tab]);
    else showPanel(id);
  };
  const sidebarTabs = navigationPanelIds.map(id => getTab(model, id)).filter(tab => tab !== undefined);
  const sidebarShown = sidebarTabs.some(tab => isPanelShown(model, tab));
  const toggleSidebar = () => {
    const docked = sidebarTabs.filter(tab => tabsetOf(tab));
    if (sidebarShown) {
      hidePanels(model, docked, true);
      return;
    }
    restorePanelSizes(model);
    if (docked.length) return;

    const hidden = sidebarTabs.filter(tab => tab.getConfig()?.leveDock?.sidebar);
    const tabs = hidden.length ? hidden : navigationPanelIds.map(id => getTab(model, id) ?? panelTabs[id]);
    tabs.forEach(tab => dockPanel(model, tab, false));
    const selected = hidden.find(tab => tab.getConfig()?.leveDock?.selected) ?? getTab(model, 'explorer');
    if (selected) revealTab(model, selected);
  };
  const toggleTerminal = (origin: HTMLElement) => {
    const tabs = terminalTabs(model);
    if (tabs.some(tab => isPanelShown(model, tab))) hidePanels(model, tabs);
    else if (tabs.length) {
      restorePanelSizes(model);
      tabs.forEach(tab => dockPanel(model, tab, false));
      revealTab(model, tabs[0]);
    } else requestAnimationFrame(() => showTerminalMenu(origin));
  };
  const restoreWorkspace = () => {
    restorePanelSizes(model);
    panelIds.forEach(id => dockPanel(model, getTab(model, id) ?? panelTabs[id], false));
    terminalTabs(model).forEach(tab => dockPanel(model, tab, false));
  };
  const terminalShown = titleMenu?.name === 'View' && terminalTabs(model).some(tab => isPanelShown(model, tab));

  return <div ref={appShell} className="app-shell" onContextMenuCapture={event => event.preventDefault()}>
    <header className={native ? 'titlebar desktop-titlebar' : 'titlebar'} inert={switchingBranch} data-tauri-drag-region={native ? '' : undefined}>
      <div className="titlebar-start" data-tauri-drag-region={native ? '' : undefined}>
        <div className="app-name"><Code2 size={16} aria-hidden="true" /><strong>leve</strong></div>
        <nav className="titlebar-menus" aria-label="Application menus" data-tauri-drag-region="false">
          {titleMenuNames.map(name => <button key={name} data-tauri-drag-region="false" aria-label={name === 'Settings' ? 'Settings menu' : undefined} aria-haspopup="menu" aria-expanded={titleMenu?.name === name}
            onPointerEnter={event => {
              if (event.pointerType !== 'mouse') return;
              const origin = event.currentTarget;
              setTitleMenu(current => current && current.name !== name ? { name, origin } : current);
            }}
            onPointerDown={event => {
              // Let the trigger handle this click before PopupMenu dismisses outside presses.
              if (titleMenu) event.stopPropagation();
            }}
            onClick={event => {
              const origin = event.currentTarget;
              setTitleMenu(current => current?.name === name ? null : { name, origin });
            }}>{name}</button>)}
        </nav>
        <button className="sidebar-toggle" data-tauri-drag-region="false" type="button"
          aria-label={sidebarShown ? 'Hide sidebar' : 'Show sidebar'} title={sidebarShown ? 'Hide sidebar' : 'Show sidebar'}
          aria-expanded={sidebarShown} onClick={toggleSidebar}>
          {sidebarShown ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
        </button>
      </div>
      <button ref={projectPicker} className="project-picker" data-tauri-drag-region="false" title={root || 'Switch project'} aria-haspopup="menu" aria-expanded={projectMenu} aria-controls={projectMenu ? 'project-menu' : undefined} disabled={switchingProject} onClick={() => setProjectMenu(value => !value)}><Folder size={13} /><span>{root ? fileName(root) : 'No folder open'}</span><ChevronDown size={12} /></button>
      <div className="titlebar-actions" data-tauri-drag-region="false">
        <button className="icon-button" title="Open settings" onClick={() => setSettings('appearance')}><Settings2 size={16} /></button>
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
    <div className="workspace" inert={switchingBranch}><aside className="activity-bar" aria-label="Navigation">
      <button title="Explorer" className="activity-button" aria-pressed={navigationSelected('explorer')} onClick={() => showPanel('explorer')}><Files size={19} /></button>
      <button title="Find files (Ctrl+P)" className="activity-button" aria-pressed={navigationSelected('search')} onClick={() => { showPanel('search'); setTimeout(() => document.getElementById('file-search')?.focus(), 0); }}><Search size={19} /></button>
      <button title="Git changes" className="activity-button" aria-pressed={gitSelected} onClick={() => showPanel('git')}><GitBranch size={19} /></button>
      <button title="New terminal" className="activity-button" onClick={openTerminalMenu}><TerminalSquare size={21} /></button>
      <div className="activity-spacer" /><button title="Settings" className="activity-button" onClick={() => setSettings('appearance')}><Settings2 size={21} /></button>
    </aside><main className="layout-host" onMouseDownCapture={event => {
      if (event.button === 1 && event.target instanceof Element && event.target.closest('[role="tab"]')) event.preventDefault();
    }}><Layout model={model} factory={factory} onAction={onAction}
      onAuxMouseClick={(node, event) => {
        if (event.button !== 1 || !(node instanceof TabNode) || !node.isCloseable()) return;
        event.preventDefault();
        event.stopPropagation();
        closeTab(node);
      }}
      onContextMenu={(node, event) => {
        if (!(node instanceof TabNode) || !node.isCloseable()) return;
        event.stopPropagation();
        const origin = event.currentTarget;
        const anchor = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : origin;
        setTabMenu({ tab: node, anchor, origin });
      }}
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
      onRenderTabSet={(node, values) => { if (node === terminalTabset(model)) values.buttons.push(<button key="new" className="icon-button" title="New terminal" aria-haspopup="menu" onClick={openTerminalMenu}><Plus size={14} /></button>); }}
    />
      {tabMenu && model.getNodeById(tabMenu.tab.getId()) === tabMenu.tab && <PopupMenu
        anchor={tabMenu.anchor} container={tabMenu.tab.getLayoutRef() ?? undefined} returnFocusTo={tabMenu.origin}
        classNameMapper={workspaceMenuClassName}
        title="Tab actions" items={[{ key: 'close', label: 'Close tab', icon: <X size={14} />, onSelect: () => closeTab(tabMenu.tab) }]}
        onClose={() => setTabMenu(null)}
      />}
    </main></div>
    {titleMenu && appShell.current && <PopupMenu
      key={titleMenu.name}
      anchor={{ x: titleMenu.origin.getBoundingClientRect().left, y: titleMenu.origin.getBoundingClientRect().bottom }}
      container={appShell.current} returnFocusTo={titleMenu.origin} title={titleMenu.name}
      classNameMapper={workspaceMenuClassName}
      onClose={() => setTitleMenu(null)}
      items={titleMenu.name === 'File' ? [
        { key: 'open', label: 'Open folder…', icon: <FolderOpen size={14} />, onSelect: () => void openFolder() },
        { key: 'recent', label: 'Recent projects…', icon: <Folder size={14} />, onSelect: () => requestAnimationFrame(() => setProjectMenu(true)) },
        { type: 'divider', key: 'files' },
        { key: 'save', label: 'Save file', disabled: !activeFile || activeImage, onSelect: () => void saveFile(activeFile) },
        { key: 'save-all', label: 'Save All', disabled: !canSaveAll, onSelect: () => void saveAll() },
        { key: 'save-as', label: 'Save As…', disabled: !canSaveAs, onSelect: () => openSaveAs() },
        { key: 'save-copy-as', label: 'Save a Copy As…', disabled: !canSaveAs, onSelect: () => openSaveAs(activeFile, 'saveCopyAs') },
      ] : titleMenu.name === 'Edit' ? [
        { key: 'indent-spaces', label: 'Convert Indentation to Spaces', disabled: !activeDocument || activeImage || fileBusy, onSelect: () => activeEditor.current?.convertIndentation('spaces') },
        { key: 'indent-tabs', label: 'Convert Indentation to Tabs', disabled: !activeDocument || activeImage || fileBusy, onSelect: () => activeEditor.current?.convertIndentation('tabs') },
      ] : titleMenu.name === 'Settings' ? [
        { key: 'settings', label: 'Open Settings…', icon: <Settings2 size={14} />, onSelect: () => requestAnimationFrame(() => setSettings('appearance')) },
        { key: 'editor-settings', label: 'Editor Settings…', onSelect: () => requestAnimationFrame(() => setSettings('editor')) },
        { key: 'shortcuts', label: 'Keyboard Shortcuts…', onSelect: () => requestAnimationFrame(() => setSettings('shortcuts')) },
      ] : [
        { key: 'restore', label: 'Restore workspace', icon: <LayoutTemplate size={14} />, onSelect: restoreWorkspace },
        { type: 'divider', key: 'panels' },
        ...panelIds.map(id => {
          const shown = isPanelShown(model, getTab(model, id));
          return { key: id, label: `${shown ? 'Hide' : 'Show'} ${panelTabs[id].name}`, icon: <Check size={14} visibility={shown ? 'visible' : 'hidden'} />, onSelect: () => togglePanel(id) };
        }),
        { key: 'terminal', label: `${terminalShown ? 'Hide' : 'Show'} Terminal`, icon: <Check size={14} visibility={terminalShown ? 'visible' : 'hidden'} />, onSelect: () => toggleTerminal(titleMenu.origin) },
      ]}
    />}
    <footer className="statusbar"><span className="status-indicator" />{native ? 'Local' : 'Web preview'}<span className="status-divider" /><span>{root ? fileName(root) : 'Demo project'}</span><div className="status-spacer" /><span title={checkpointTime ? `Last recovery checkpoint: ${checkpointTime}` : 'Preparing recovery'}>{recoveryError || recoveryLocked ? 'Recovery unavailable' : checkpointTime ? 'Recovery saved' : 'Recovery pending'}</span>{activeImage ? <span>Image · Read-only</span> : <>
      <span>Ln {position.line}, Col {position.col}</span>
      {activeDocument && <select className="status-select status-indentation" aria-label="File indentation" title="Change indentation for this tab" value={activeDocument.indentation ? `${activeDocument.indentation.indentStyle}:${activeDocument.indentation.indentSize}` : 'auto'} onChange={event => {
        const [style, value] = event.target.value.split(':');
        const size = Number(value);
        const indentation: OpenFile['indentation'] = (style === 'spaces' || style === 'tabs') && indentSizes.some(option => option === size)
          ? { indentStyle: style, indentSize: size, tabWidth: size } : undefined;
        setFiles(previous => {
          const file = previous[activeFile];
          if (!file) return previous;
          return { ...previous, [activeFile]: { ...file, indentation } };
        });
      }}>
        <option value="auto">{automaticIndentationLabel}</option>
        {indentSizes.map(size => <option key={`spaces:${size}`} value={`spaces:${size}`}>Spaces: {size}</option>)}
        {indentSizes.map(size => <option key={`tabs:${size}`} value={`tabs:${size}`}>Tabs: {size}</option>)}
      </select>}
      {activeDocument && <button className="status-select status-encoding" aria-label={`File encoding: ${textEncoding(activeContent)}`} aria-haspopup="menu" aria-expanded={encodingMenu?.path === activeFile} disabled={fileBusy || switchingBranch || switchingProject || closing || !!recoveryBlocked} onClick={event => {
        const origin = event.currentTarget;
        setEncodingMenu(current => current ? null : { path: activeFile, origin });
      }}>{textEncoding(activeContent)}</button>}
      {activeDocument && <select className="status-select" aria-label="Line endings" title="Change line endings for this file" value={lineEndings} disabled={fileBusy || switchingBranch || !!recoveryBlocked} onChange={event => {
        const lineEnding = event.target.value;
        if (lineEnding !== 'LF' && lineEnding !== 'CRLF') return;
        setFiles(previous => {
          if (!Object.hasOwn(previous, activeFile)) return previous;
          const file = previous[activeFile];
          return { ...previous, [activeFile]: { ...file, lineEnding, content: convertLineEndings(file.content, lineEnding) } };
        });
      }}>
        {lineEndings !== 'LF' && lineEndings !== 'CRLF' && <option value={lineEndings} disabled>{lineEndings}</option>}
        <option value="LF">LF</option><option value="CRLF">CRLF</option>
      </select>}
      <span>{activeFile ? languageName(activeFile) : 'Leve'}</span>
    </>}</footer>
    {encodingMenu?.path === activeFile && appShell.current && <PopupMenu
      anchor={{ x: encodingMenu.origin.getBoundingClientRect().left, y: encodingMenu.origin.getBoundingClientRect().top }}
      container={appShell.current} returnFocusTo={encodingMenu.origin} title="File encoding"
      classNameMapper={workspaceMenuClassName} onClose={() => setEncodingMenu(null)}
      items={[
        { key: 'reopen', label: 'Reopen from disk', onSelect: () => void reopenTextFile(encodingMenu.path) },
        { type: 'divider', key: 'encoding-options' },
        { key: 'utf8', label: 'Save as UTF-8', onSelect: () => void saveFile(encodingMenu.path, 'UTF-8') },
        { key: 'utf8-bom', label: 'Save as UTF-8 with BOM', onSelect: () => void saveFile(encodingMenu.path, 'UTF-8 with BOM') },
      ]}
    />}
    {(!sessionReady || closing || switchingBranch) && <div className="session-loading" role="status">{branchOperation === 'pull' ? 'Pulling branch…' : switchingBranch ? 'Switching branch…' : closing ? 'Saving session…' : 'Restoring session…'}</div>}
    {notice && <div className="toast" role={notice.persistent ? 'alert' : 'status'}><span>{notice.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    {fileOperation && <FileDialog key={JSON.stringify(fileOperation)} operation={fileOperation} root={localRoot} dirtyCount={'entry' in fileOperation ? Object.values(files).filter(file => withinEntry(file.path, fileOperation.entry.path) && file.content !== file.saved).length : 0} busy={fileBusy} error={fileError} onCancel={() => {
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
    {settings && <SettingsDialog initialSection={settings} versionLabel={native ? `v${version}` : 'Web preview'} explorerPreferences={explorerPreferences} onExplorerChange={setExplorerPreferences} languageOptions={languageOptions} hasProject={!!languageWorkspace}
      editorPreferences={editorPreferences} onEditorChange={setEditorPreferences}
      onLanguageChange={toggleLanguageSupport} onClose={() => setSettings(null)} onResetLayout={() => {
        const fresh = Model.fromJson(initialLayout());
        Object.values(filesRef.current).forEach(file => fresh.doAction(Actions.addNode({ type: 'tab', id: `file:${file.path}`, component: 'file', name: file.name, config: { path: file.path } }, 'documents', DockLocation.CENTER, -1)));
        setModel(fresh); persist(fresh); setSettings(null);
      }} />}
  </div>;
}
