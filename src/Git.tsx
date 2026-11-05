import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw } from 'lucide-react';
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

function useGitRequest<T>(request: (() => Promise<T>) | null, refresh: string) {
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
  return result?.request === request && result.refresh === refresh ? result : undefined;
}

type GitProps = { root: string | null; refresh: string; onRefresh: () => void };

export function useGitStatus(root: string | null, refresh: string) {
  const request = useMemo(() => root ? () => invoke<GitChange[] | null>('git_status', { expectedRoot: root }) : null, [root]);
  return useGitRequest(request, refresh);
}

export function GitPanel({ root, onRefresh, result, onOpen }: Pick<GitProps, 'root' | 'onRefresh'> & {
  result: ReturnType<typeof useGitStatus>; onOpen: (change: GitChange) => void;
}) {
  const changes = result?.data;
  const message = !native ? 'Open the desktop app to inspect a Git repository.'
    : !root ? 'Open a project folder to view its Git changes.'
    : !result ? 'Checking Git changes…'
    : changes === null ? <>No Git repository found. Run <code>git init</code> in the folder you want to track, then refresh Git changes.</>
    : changes?.length === 0 ? 'Working tree is clean.'
    : '';
  return <section className="git-panel panel-scroll" aria-label="Git changes">
    <div className="panel-heading">GIT <button className="icon-button" title="Refresh Git changes" disabled={!root} onClick={onRefresh}><RefreshCw size={14} /></button></div>
    {message && <p className="panel-description" role="status">{message}</p>}
    {result?.error && <p className="panel-description inline-error" role="alert">{result.error}</p>}
    {groups.map(([kind, label]) => {
      const entries = changes?.filter(change => change.kind === kind);
      return !!entries?.length && <section key={kind} aria-label={label}>
        <h2 className="git-group-heading">{label} <span>{entries.length}</span></h2>
        {entries.map(change => <button className="search-result git-change" key={change.path} title={change.path} onClick={() => onOpen(change)}>
          <span className="git-badge" data-git-status={change.status} title={gitStatuses[change.status]?.label}>{gitStatuses[change.status]?.badge ?? change.status}</span>
          <span>{fileName(change.path)}{fileName(change.path) !== change.path && <small>{change.path}</small>}</span>
        </button>)}
      </section>;
    })}
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

export function GitDiff({ root, refresh, onRefresh, change }: GitProps & { change: GitChange }) {
  const { path, kind } = change;
  const request = useMemo(() => root ? () => invoke<string>('git_diff', { expectedRoot: root, path, kind }) : null, [root, path, kind]);
  const result = useGitRequest(request, refresh);
  const lines = useMemo(() => result?.data ? patchLines(result.data) : null, [result?.data]);
  return <section className="git-diff" aria-label="Git diff">
    <div className="git-diff-heading">
      <div><strong>{path}</strong><small>{groups.find(([value]) => value === kind)?.[1]} · Read-only</small></div>
      <button className="icon-button" title="Refresh Git diff" disabled={!root} onClick={onRefresh}><RefreshCw size={14} /></button>
    </div>
    {result?.error ? <p className="panel-description inline-error" role="alert">{result.error}</p>
      : lines ? <pre className="git-patch" tabIndex={0} aria-label="Unified diff">{lines}</pre>
      : <p className="panel-description" role="status">{!root ? 'Open the project folder to view its diff.' : !result ? 'Loading diff…' : 'No changes in this comparison. Refresh the Git panel to update the file list.'}</p>}
  </section>;
}
