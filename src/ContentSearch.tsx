import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { cancelSearch, searchContent, type ContentMatch, type ContentResults } from './workspace';

export default function ContentSearch({ heading, root, blocked, refresh, onOpen }: { heading: ReactNode; root: string | null; blocked: boolean; refresh: number; onOpen: (match: ContentMatch) => void }) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<ContentResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setResult(null); setError('');
    if (!query || blocked) { setBusy(false); return; }
    let active = true;
    const id = crypto.randomUUID();
    setBusy(true);
    const timer = setTimeout(() => {
      void searchContent(query, caseSensitive, id, root).then(data => { if (active) setResult(data); })
        .catch(err => { if (active) setError(String(err)); }).finally(() => { if (active) setBusy(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); cancelSearch(id); };
  }, [query, caseSensitive, root, blocked, refresh, revision]);
  return <>
    <div className="panel-toolbar search-tools">
      {heading}
      <label className="search-input"><Search size={14} /><input id="content-search" aria-label="Search project contents" maxLength={256} placeholder="Search text in project" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="search-options"><label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} /> Match case</label><button className="icon-button" title="Search again" onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} /></button></div>
    </div>
    <div className="panel-body content-search">
      <p className="panel-description">Saved UTF-8 files · literal text. Save edits before searching. Skips dependencies, build folders, links, binary files and files over 1 MB.</p>
      {blocked && <p className="inline-error">Reopen the project before searching its contents.</p>}
      {error && <p role="alert" className="inline-error">{error}</p>}
      <p className="panel-description" role="status">{busy ? 'Searching…' : result ? `${result.matches.length} match(es) in ${result.scanned} searched file(s). ${result.skipped} skipped.` : 'Enter text to search across your project.'}</p>
      {result?.limit && <p role="alert" className="inline-error">{result.limit}</p>}
      {result?.matches.map((match, index) => <button className="search-result content-result" key={`${match.path}:${match.line}:${match.column}:${index}`} onClick={() => onOpen(match)}><span><strong>{match.path}:{match.line}:{match.column}</strong><small>{match.preview}</small></span></button>)}
    </div>
  </>;
}
