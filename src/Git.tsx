import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDown, ArrowUp, Check, ChevronDown, Download, Ellipsis, GitBranch, Minus, Plus, RefreshCw } from 'lucide-react';
import { fileName, native } from './workspace';

const groups = [
  ['staged', 'Staged changes'],
  ['working', 'Working tree changes'],
  ['untracked', 'Untracked files'],
] as const;

export const gitStatuses = {
  A: { badge: 'A', label: 'Added' },
  M: { badge: 'M', label: 'Modified' },
  D: { badge: 'D', label: 'Deleted' },
  T: { badge: 'T', label: 'Type changed' },
  U: { badge: '!', label: 'Conflict' },
  '?': { badge: 'U', label: 'Untracked' },
};
export type GitStatus = keyof typeof gitStatuses;
export type GitChange = { path: string; kind: typeof groups[number][0]; status: GitStatus };
type Repository = { id: string; branch: string | null; head: string | null; canSwitch: boolean; changes: GitChange[] };
type IndexAction = 'stage' | 'unstage';
type RemoteAction = 'push' | 'publish' | 'fetch' | 'pull';
type PushTarget = { remote: string; reference: string };
type PullBranch = (repo: string, request: { branch: string; head: string; target: PushTarget }) => Promise<void>;
type RemoteStatus = { remotes: string[]; upstream: PushTarget | null; comparison: { ahead: number; behind: number } | null };
type GitAction = IndexAction | 'commit' | RemoteAction;
const actionMessage: Record<GitAction, string> = {
  stage: 'Staging saved changes…', unstage: 'Unstaging changes…', commit: 'Creating commit…',
  push: 'Pushing branch…', publish: 'Publishing branch…', fetch: 'Fetching remote…', pull: 'Pulling branch…',
};
const canUpdateIndex = (change: GitChange) => change.status !== 'U' && !change.path.endsWith('/');
export type GitCommit = { id: string; subject: string; author: string; date: number };
export type GitCommitSelection = { repo: string; commit: GitCommit };

export function gitDecorations(changes: GitChange[] | null | undefined) {
  const files = new Map<string, GitStatus>();
  const folders = new Map<string, GitStatus>();
  for (const change of changes ?? []) {
    if (change.kind !== 'staged' || !files.has(change.path)) files.set(change.path, change.status);
  }
  const priority = { U: 3, M: 2, T: 2, A: 1, '?': 1 };
  for (const [path, status] of files) {
    if (status === 'D') continue;
    for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
      const folder = path.slice(0, end);
      const previous = folders.get(folder);
      if (!previous || previous === 'D' || priority[status] > priority[previous]) folders.set(folder, status);
    }
  }
  return { files, folders };
}

export type GitDecorations = ReturnType<typeof gitDecorations>;

function useGitRequest<T>(request: (() => Promise<T>) | null, refresh: string, keepData = false) {
  const [result, setResult] = useState<{ request: typeof request; refresh: string; data?: T; error?: string }>();
  useEffect(() => {
    if (!request) return;
    let current = true;
    void request().then(data => {
      if (current) setResult({ request, refresh, data });
    }).catch(error => {
      if (current) setResult({ request, refresh, error: String(error) });
    });
    return () => { current = false; };
  }, [request, refresh]);
  return result?.request === request && (result.refresh === refresh || (keepData && result.data !== undefined)) ? result : undefined;
}

type GitProps = { root: string | null; refresh: string; onRefresh: () => void };

export function useGitStatus(root: string | null, refresh: string) {
  const request = useMemo(() => root ? () => invoke<Repository[]>('git_status', { expectedRoot: root }) : null, [root]);
  return useGitRequest(request, refresh, true);
}

export function GitPanel({ root, refresh, onRefresh, result, onOpen, onCommit, onSwitch, onPull }: GitProps & {
  result: ReturnType<typeof useGitStatus>;
  onOpen: (change: GitChange) => void;
  onCommit: (selection: GitCommitSelection) => void;
  onSwitch: (repo: string, branch: string) => Promise<void>;
  onPull: PullBranch;
}) {
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [actionsOpen, setActionsOpen] = useState(false);
  const [action, setAction] = useState<GitAction | null>(null);
  const [actionError, setActionError] = useState('');
  const [drafts, setDrafts] = useState(() => new Map<string, string>());
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const repositories = result?.data;
  const repo = repositories?.find(item => item.id === selected) ?? repositories?.[0];
  const changes = repo?.changes;
  const indexDisabled = action !== null || result?.refresh !== refresh;
  const stagePaths = changes?.filter(change => change.kind !== 'staged' && canUpdateIndex(change)).map(change => change.path) ?? [];
  const unstagePaths = changes?.filter(change => change.kind === 'staged' && canUpdateIndex(change)).map(change => change.path) ?? [];
  const draftKey = JSON.stringify([repo?.id, repo?.branch]);
  const draft = drafts.get(draftKey) ?? '';
  const hasConflicts = changes?.some(change => change.status === 'U');
  const commitDisabled = indexDisabled || !repo?.canSwitch || !repo.branch || !unstagePaths.length || !draft.trim() || hasConflicts;
  const setDraft = (value: string) => setDrafts(previous => {
    const next = new Map(previous);
    if (value) next.set(draftKey, value);
    else next.delete(draftKey);
    return next;
  });
  const runAction = async (operation: GitAction, request: () => Promise<unknown>) => {
    setAction(operation);
    setActionError('');
    try { await request(); return true; }
    catch (failure) { setActionError(String(failure)); return false; }
    finally { onRefresh(); setAction(null); }
  };
  const updateIndex = (operation: IndexAction, paths: string[]) => {
    if (!root || !repo || !paths.length || indexDisabled) return;
    void runAction(operation, () => invoke('git_update_index', { expectedRoot: root, repo: repo.id, action: operation, paths }));
  };
  const submitCommit = async () => {
    if (!root || !repo || commitDisabled) return;
    const request = { branch: repo.branch, head: repo.head, paths: unstagePaths, message: draft };
    if (await runAction('commit', () => invoke('git_create_commit', { expectedRoot: root, repo: repo.id, request }))) setDraft('');
  };
  const message = !native ? 'Open the desktop app to inspect a Git repository.'
    : !root ? 'Open a project folder to view its Git changes.'
    : !result ? 'Checking Git changes…'
    : repositories?.length === 0 ? <>No Git repository found. Run <code>git init</code> in the folder you want to track, then refresh Git changes.</>
    : view === 'changes' && changes?.length === 0 ? 'Working tree is clean.'
    : '';
  return <section className="git-panel panel-layout" aria-label="Git changes">
    <div className="panel-toolbar git-toolbar">
      <div className="panel-heading">GIT <button className="icon-button" title="Refresh Git changes" disabled={!root} onClick={onRefresh}><RefreshCw size={14} /></button></div>
      {root && repo && <>
        {!!repositories && repositories.length > 1 && <label className="git-repository">Repository
          <select value={repo.id} disabled={action !== null} onChange={event => { setSelected(event.target.value); setActionError(''); setActionsOpen(false); }}>
            {repositories.map(item => <option key={item.id} value={item.id}>{item.id || 'Project folder'}</option>)}
          </select>
        </label>}
        <BranchPicker key={repo.id} root={root} repo={repo} refresh={refresh} onSwitch={onSwitch} blocked={action !== null} />
        {repo.canSwitch && repo.branch && repo.head && <GitRemoteActions key={JSON.stringify([repo.id, repo.branch])} root={root} repo={repo.id} branch={repo.branch} head={repo.head} refresh={refresh} blocked={indexDisabled} runAction={runAction} onPull={onPull} />}
        <div className="git-views" role="group" aria-label="Git view">
          <button aria-pressed={view === 'changes'} onClick={() => setView('changes')}>Changes</button>
          <button aria-pressed={view === 'history'} onClick={() => setView('history')}>History</button>
        </div>
      </>}
      {view === 'changes' && repo && <div className="git-index-actions" onKeyDown={event => {
        if (event.key === 'Escape' && actionsOpen) { event.stopPropagation(); setActionsOpen(false); actionsTrigger.current?.focus(); }
      }}>
        <button ref={actionsTrigger} className="icon-button" aria-label="Staging actions" title="Staging actions" aria-expanded={actionsOpen} onClick={() => setActionsOpen(value => !value)}><Ellipsis size={16} /></button>
        {actionsOpen && <div className="git-index-menu" role="group" aria-label="Bulk staging actions">
          <button className="search-result" disabled={indexDisabled || !stagePaths.length} onClick={() => { setActionsOpen(false); actionsTrigger.current?.focus(); void updateIndex('stage', stagePaths); }}><Plus size={14} />Stage All</button>
          <button className="search-result" disabled={indexDisabled || !unstagePaths.length} onClick={() => { setActionsOpen(false); actionsTrigger.current?.focus(); void updateIndex('unstage', unstagePaths); }}><Minus size={14} />Unstage All</button>
        </div>}
      </div>}
      {action && <p className="panel-description" role="status">{actionMessage[action]}</p>}
      {actionError && <p className="panel-description inline-error" role="alert">{actionError}</p>}
      {view === 'changes' && repo && (repo.canSwitch && repo.branch ? <form className="git-commit-form" onSubmit={event => { event.preventDefault(); void submitCommit(); }}>
        <label>Commit message<textarea rows={3} maxLength={16_384} value={draft} disabled={action === 'commit'} onChange={event => setDraft(event.target.value)} placeholder="Describe the staged changes…" /></label>
        <div className="git-commit-actions"><span>{hasConflicts ? 'Resolve conflicts before committing.' : `${unstagePaths.length} staged ${unstagePaths.length === 1 ? 'file' : 'files'}`}</span>
          <button type="submit" className="button primary" disabled={commitDisabled}>Commit</button>
        </div>
      </form> : <p className="panel-description">{repo.canSwitch ? 'Switch to a branch to commit.' : 'Open the repository root to commit.'}</p>)}
    </div>
    <div className="panel-body" role="region" aria-label="Git results" tabIndex={0} key={JSON.stringify([repo?.id, repo?.branch, view, view === 'history' ? repo?.head : null])}>
      {message && <p className="panel-description" role="status">{message}</p>}
      {result?.error && <p className="panel-description inline-error" role="alert">{result.error}</p>}
      {view === 'history' && root && repo && <GitHistory key={JSON.stringify([repo.id, repo.head])} root={root} repo={repo} refresh={refresh} onCommit={onCommit} />}
      {view === 'changes' && groups.map(([kind, label]) => {
        const entries = changes?.filter(change => change.kind === kind);
        return !!entries?.length && <section key={kind} aria-label={label}>
          <h2 className="git-group-heading">{label} <span>{entries.length}</span></h2>
          {entries.map(change => {
            const staged = change.kind === 'staged';
            const label = `${staged ? 'Unstage' : 'Stage'} ${change.path}`;
            return <div className="git-change-row" key={change.path}>
              <button className="search-result git-change" aria-label={`View diff for ${change.path}`} title={change.path} onClick={() => onOpen(change)}>
                <span className="git-badge" data-git-status={change.status} title={gitStatuses[change.status]?.label}>{gitStatuses[change.status]?.badge ?? change.status}</span>
                <span>{fileName(change.path)}{fileName(change.path) !== change.path && <small>{change.path}</small>}</span>
              </button>
              {canUpdateIndex(change) && <button className="icon-button git-index-button" aria-label={label} title={staged ? label : `${label} (saved changes)`} disabled={indexDisabled} onClick={() => void updateIndex(staged ? 'unstage' : 'stage', [change.path])}>
                {staged ? <Minus size={14} /> : <Plus size={14} />}
              </button>}
            </div>;
          })}
        </section>;
      })}
    </div>
  </section>;
}

function GitRemoteActions({ root, repo, branch, head, refresh, blocked, runAction, onPull }: {
  root: string; repo: string; branch: string; head: string; refresh: string; blocked: boolean;
  runAction: (operation: RemoteAction, request: () => Promise<unknown>) => Promise<boolean>;
  onPull: PullBranch;
}) {
  const [selectedRemote, setSelectedRemote] = useState('');
  const [notice, setNotice] = useState('');
  const request = useMemo(() => () => invoke<RemoteStatus>('git_remote_status', { expectedRoot: root, repo, branch }), [root, repo, branch]);
  const result = useGitRequest(request, refresh, true);
  if (!result) return null;
  if (result.error) return <p className="panel-description inline-error" role="alert">{result.error}</p>;
  if (!result.data) return null;
  const { upstream, remotes, comparison } = result.data;
  if (remotes.length === 0) return <p className="git-remote-hint">Add a Git remote to publish this branch.</p>;
  const prefix = 'refs/heads/';
  const remote = remotes.length === 1 ? remotes[0] : selectedRemote;
  const target = upstream ?? { remote, reference: `${prefix}${branch}` };
  const publish = upstream === null;
  const destination = `${target.remote}/${target.reference.slice(prefix.length)}`;
  const available = remotes.includes(target.remote) && target.reference.startsWith(prefix);
  const stale = blocked || result.refresh !== refresh;
  const send = async () => {
    setNotice('');
    if (await runAction(publish ? 'publish' : 'push', () => invoke('git_push', { expectedRoot: root, repo, request: { branch, head, target, publish } }))) {
      setNotice(`${publish ? 'Published to' : 'Pushed to'} ${destination}.`);
    }
  };
  const receive = async (operation: 'fetch' | 'pull') => {
    setNotice('');
    const request = operation === 'fetch'
      ? () => invoke('git_receive', { expectedRoot: root, repo, request: { operation, remote: target.remote } })
      : () => onPull(repo, { branch, head, target });
    if (await runAction(operation, request)) setNotice(operation === 'fetch' ? `Fetched from ${target.remote}.` : `Checked for updates from ${destination}.`);
  };
  return <div className="git-remote-actions">
    {publish && remotes.length > 1 && <label className="git-repository">Push remote
      <select value={selectedRemote} disabled={blocked} onChange={event => setSelectedRemote(event.target.value)}>
        <option value="">Choose a remote…</option>
        {remotes.map(remote => <option key={remote}>{remote}</option>)}
      </select>
    </label>}
    <div className="git-remote-row">
      {available && <span title={destination}>{destination}</span>}
      <button className="button secondary" disabled={stale || !remotes.includes(target.remote)} onClick={() => void receive('fetch')}><Download size={13} />Fetch</button>
      {!publish && <button className="button secondary" title="Pull upstream changes (fast-forward only)" disabled={stale || !available} onClick={() => void receive('pull')}><ArrowDown size={13} />Pull</button>}
      <button className="button secondary" disabled={stale || !available} onClick={() => void send()}><ArrowUp size={13} />{publish ? 'Publish Branch' : 'Push'}</button>
    </div>
    {upstream && (available ? <div className="git-upstream-status" aria-live="polite" title="Compared with the last fetched upstream reference">
      {comparison ? (comparison.ahead || comparison.behind ? `${comparison.ahead} ahead · ${comparison.behind} behind` : 'Up to date with upstream') : 'Upstream comparison unavailable'}
    </div> : <small>The upstream does not point to an available remote branch.</small>)}
    <small aria-live="polite">{notice}</small>
  </div>;
}

function BranchPicker({ root, repo, refresh, onSwitch, blocked }: { root: string; repo: Repository; refresh: string; onSwitch: (repo: string, branch: string) => Promise<void>; blocked: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useMemo(() => open && repo.canSwitch ? () => invoke<string[]>('git_branches', { expectedRoot: root, repo: repo.id }) : null, [open, root, repo.id, repo.canSwitch]);
  const result = useGitRequest(request, refresh, true);
  const matches = result?.data?.filter(branch => branch.toLowerCase().includes(query.toLowerCase()));
  const label = repo.branch ? `${repo.branch}${repo.head ? '' : ' (no commits)'}` : `Detached HEAD${repo.head ? ` · ${repo.head.slice(0, 7)}` : ''}`;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = async (branch: string) => {
    if (busy || blocked || branch === repo.branch) return;
    setBusy(true); setError('');
    try { await onSwitch(repo.id, branch); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  return <div className="git-branch-picker" onKeyDown={event => {
    if (event.key === 'Escape' && open && !busy) { event.stopPropagation(); close(); }
  }}>
    {repo.canSwitch ? <button ref={trigger} className="git-branch-trigger" title={label} aria-label={`Switch branch (current: ${label})`} aria-expanded={open} disabled={blocked} onClick={() => {
      if (open) close();
      else { setQuery(''); setError(''); setOpen(true); }
    }}><GitBranch size={14} /><span>{label}</span><ChevronDown size={13} /></button>
      : <div className="git-branch-trigger" title={label}><GitBranch size={14} /><span>{label}</span></div>}
    {!repo.canSwitch && <small className="git-branch-hint">Open the repository root to switch branches.</small>}
    {open && <div className="git-branch-options" role="group" aria-label="Local branches">
      <input autoFocus aria-label="Search local branches" placeholder="Search local branches…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key !== 'Enter') return;
        if (query && matches?.length === 1) { event.preventDefault(); void choose(matches[0]); }
      }} />
      {busy && <p className="panel-description" role="status">Switching branch…</p>}
      {!result && !busy && <p className="panel-description" role="status">Loading local branches…</p>}
      {matches?.length === 0 && <p className="panel-description" role="status">{query ? 'No matching branches.' : 'No local branches yet.'}</p>}
      {(error || result?.error) && <p className="panel-description inline-error" role="alert">{error || result?.error}</p>}
      <div className="git-branch-list">{matches?.map(branch => <button key={branch} className="search-result" title={branch} disabled={busy || blocked || branch === repo.branch} onClick={() => void choose(branch)}>
        {branch === repo.branch ? <Check size={14} /> : <GitBranch size={14} />}<span>{branch}{branch === repo.branch && <small>Current branch</small>}</span>
      </button>)}</div>
    </div>}
  </div>;
}

type HistoryPage = { commits: GitCommit[]; hasMore: boolean };
const relativeDate = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function commitDate(seconds: number) {
  const minutes = (seconds * 1000 - Date.now()) / 60_000;
  const hours = minutes / 60;
  const days = hours / 24;
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(hours) < 1) return relativeDate.format(Math.trunc(minutes), 'minute');
  if (Math.abs(days) < 1) return relativeDate.format(Math.trunc(hours), 'hour');
  if (Math.abs(days) < 30) return relativeDate.format(Math.trunc(days), 'day');
  return new Date(seconds * 1000).toLocaleDateString();
}

function GitHistory({ root, repo, refresh, onCommit }: { root: string; repo: Repository; refresh: string; onCommit: (selection: GitCommitSelection) => void }) {
  const [offset, setOffset] = useState(0);
  const [earlierPages, setEarlierPages] = useState<GitCommit[]>([]);
  const request = useMemo(() => repo.head ? () => invoke<HistoryPage>('git_history', { expectedRoot: root, repo: repo.id, head: repo.head, skip: offset }) : null, [root, repo.id, repo.head, offset]);
  const result = useGitRequest(request, refresh, true);
  const page = result?.data;
  const commits = page ? [...earlierPages, ...page.commits] : earlierPages;
  return <section aria-label="Commit history">
    {!repo.head ? <p className="panel-description" role="status">No commits yet.</p> : !result && <p className="panel-description" role="status">Loading commits…</p>}
    {result?.error && <p className="panel-description inline-error" role="alert">{result.error}</p>}
    {page && !commits.length && <p className="panel-description" role="status">No commits in this folder.</p>}
    {commits.map(commit => <button className="search-result git-commit" key={commit.id} title={commit.subject} onClick={() => onCommit({ repo: repo.id, commit })}>
      <span>{commit.subject || '(No commit message)'}<small>{commit.author} · {commitDate(commit.date)} · {commit.id.slice(0, 7)}</small></span>
    </button>)}
    {page?.hasMore && <button className="button secondary git-more" onClick={() => { setEarlierPages(commits); setOffset(commits.length); }}>Load more</button>}
  </section>;
}

function patchLines(patch: string) {
  let columns = 0;
  return patch.split(/(?<=\n)/).map((line, index) => {
    if (line.startsWith('diff --')) columns = 0;
    const hunk = line.match(/^(@{2,}) /);
    if (hunk) {
      columns = hunk[1].length - 1;
      return <span key={index} className="git-hunk">{line}</span>;
    }
    const markers = line.slice(0, columns);
    const color = !columns ? 'git-meta' : markers.includes('+') ? 'git-addition' : markers.includes('-') ? 'git-deletion' : '';
    return <span key={index} className={color}>{line}</span>;
  });
}

export function GitDiff({ root, refresh, onRefresh, change, available }: GitProps & { change: GitChange; available?: boolean }) {
  const { path, kind } = change;
  const request = useMemo(() => root && available !== false ? () => invoke<string>('git_diff', { expectedRoot: root, path, kind }) : null, [root, path, kind, available]);
  const result = useGitRequest(request, refresh);
  return <section className="git-diff" aria-label="Git diff">
    <div className="git-diff-heading">
      <div><strong>{path}</strong><small>{groups.find(([value]) => value === kind)?.[1]} · Read-only</small></div>
      <button className="icon-button" title="Refresh Git diff" disabled={!root} onClick={onRefresh}><RefreshCw size={14} /></button>
    </div>
    {!root ? <p className="panel-description" role="status">Open the project folder to view its diff.</p>
      : available === false ? <p className="panel-description" role="status">This file is no longer in this change group.</p>
      : <Patch result={result} empty="No changes in this comparison. Refresh the Git panel to update the file list." />}
  </section>;
}

function Patch({ result, empty }: { result?: { data?: string; error?: string }; empty: string }) {
  const lines = useMemo(() => result?.data ? patchLines(result.data) : null, [result?.data]);
  if (result?.error) return <p className="panel-description inline-error" role="alert">{result.error}</p>;
  if (lines) return <pre className="git-patch" tabIndex={0} aria-label="Unified diff">{lines}</pre>;
  return <p className="panel-description" role="status">{result ? empty : 'Loading diff…'}</p>;
}

export function GitCommitView({ root, refresh, onRefresh, selection }: GitProps & { selection: GitCommitSelection }) {
  const { repo, commit } = selection;
  const [selectedPath, setSelectedPath] = useState('');
  const filesRequest = useMemo(() => root ? () => invoke<string[]>('git_commit_files', { expectedRoot: root, repo, commit: commit.id }) : null, [root, repo, commit.id]);
  const files = useGitRequest(filesRequest, refresh, true);
  const path = files?.data?.includes(selectedPath) ? selectedPath : files?.data?.[0];
  const diffRequest = useMemo(() => root && path ? () => invoke<string>('git_commit_diff', { expectedRoot: root, repo, commit: commit.id, path }) : null, [root, repo, commit.id, path]);
  const patch = useGitRequest(diffRequest, refresh, true);
  return <section className="git-diff" aria-label="Git commit">
    <div className="git-diff-heading">
      <div><strong>{commit.subject || '(No commit message)'}</strong><small>{commit.author} · {new Date(commit.date * 1000).toLocaleString()} · {commit.id.slice(0, 7)} · Read-only</small></div>
      <button className="icon-button" title="Refresh commit" disabled={!root} onClick={onRefresh}><RefreshCw size={14} /></button>
    </div>
    {files?.error ? <p className="panel-description inline-error" role="alert">{files.error}</p>
      : path ? <><label className="git-repository git-commit-files">Changed files ({files?.data?.length})
        <select value={path} onChange={event => setSelectedPath(event.target.value)}>{files?.data?.map(file => <option key={file}>{file}</option>)}</select>
      </label><Patch result={patch} empty="No textual diff for this file." /></>
      : <p className="panel-description" role="status">{!root ? 'Open the project folder to view this commit.' : files ? 'No files changed.' : 'Loading changed files…'}</p>}
  </section>;
}
