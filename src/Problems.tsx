import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Copy, FileCode2, Info } from 'lucide-react';
import type { Problem } from './language';

function problemDetails({ path: _path, ...details }: Problem) {
  return details;
}

async function copyText(text: string) {
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try copying a selection from the current document. */ }
  }
  const previousFocus = document.activeElement;
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    input.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }
}

export default function Problems({ file, problems, onOpen, onCopyStatus }: {
  file: string; problems: Problem[]; onOpen: (problem: Problem) => void; onCopyStatus: (message: string) => void;
}) {
  const [fileExpanded, setFileExpanded] = useState(true);
  const [expandedProblem, setExpandedProblem] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    key: string; problem: Problem | null; left: number; top: number; origin: HTMLButtonElement | null;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menu = contextMenu?.problem
    ? (fileExpanded && problems.includes(contextMenu.problem) ? contextMenu : null)
    : (problems.length ? contextMenu : null);
  const menuExpanded = menu?.problem ? expandedProblem === menu.key : fileExpanded;
  useEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const closeOutside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) setContextMenu(null);
    };
    element.ownerDocument.addEventListener('pointerdown', closeOutside, true);
    return () => element.ownerDocument.removeEventListener('pointerdown', closeOutside, true);
  }, [menu]);

  const openMenu = (key: string, problem: Problem | null, x: number, y: number, origin: HTMLButtonElement | null) => {
    setContextMenu({
      key, problem, origin,
      left: Math.max(8, Math.min(x, window.innerWidth - 210)),
      top: Math.max(8, Math.min(y, window.innerHeight - 96)),
    });
  };
  const openMenuFromKey = (event: KeyboardEvent<HTMLButtonElement>, key: string, problem: Problem | null) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(key, problem, rect.left, rect.bottom, event.currentTarget);
  };
  const closeMenu = () => {
    setContextMenu(null);
    menu?.origin?.focus({ preventScroll: true });
  };

  const errors = problems.filter(problem => problem.severity === 'error').length;
  const warnings = problems.filter(problem => problem.severity === 'warning').length;
  const copy = async (value: unknown, message: string) => {
    try {
      await copyText(JSON.stringify(value, null, 2));
      onCopyStatus(message);
    } catch {
      onCopyStatus('Could not copy to the clipboard.');
    }
  };
  const copyAll = () => void copy({ file, problems: problems.map(problemDetails) }, 'File problems copied.');
  return <section className="problems panel-scroll" aria-label="File problems">
    {problems.length === 0 ? <p className="panel-description">{file ? 'No problems in this file.' : 'No active file.'}</p> : <>
      <div className="problems-file-header" onContextMenu={event => {
        event.preventDefault();
        openMenu('file-group', null, event.clientX, event.clientY, event.currentTarget.querySelector('.problems-file-toggle'));
      }}>
        <button className="problems-file-toggle" aria-expanded={fileExpanded} aria-haspopup="menu"
          onClick={() => setFileExpanded(value => !value)} onKeyDown={event => openMenuFromKey(event, 'file-group', null)}>
          {fileExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FileCode2 size={14} />
          <span title={file}>{file}</span>
          <small>{errors} {errors === 1 ? 'error' : 'errors'} · {warnings} {warnings === 1 ? 'warning' : 'warnings'}</small>
        </button>
        <button className="problem-copy-all" onClick={copyAll}>
          <Copy size={13} /> Copy all
        </button>
      </div>
      {fileExpanded && problems.length > 500 && <p className="panel-description">Showing first 500 of {problems.length}.</p>}
      {fileExpanded && problems.slice(0, 500).map((problem, index) => {
        const Icon = problem.severity === 'error' ? AlertCircle : problem.severity === 'warning' ? AlertTriangle : Info;
        const details = { file, ...problemDetails(problem) };
        const key = `${index}:${problem.line}:${problem.column}:${problem.message}`;
        const expanded = expandedProblem === key;
        return <div className="problem-entry" key={key} onContextMenu={event => {
          event.preventDefault();
          openMenu(key, problem, event.clientX, event.clientY, event.currentTarget.querySelector('.problem-row'));
        }}>
          <div className="problem-item">
            <button className="icon-button" aria-label="Problem details" aria-expanded={expanded} title="Problem details" onClick={() => setExpandedProblem(expanded ? '' : key)}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <button className="problem-row" onClick={() => onOpen(problem)} title={problem.message}
              aria-haspopup="menu" onKeyDown={event => openMenuFromKey(event, key, problem)}>
              <Icon size={14} className={`problem-${problem.severity}`} aria-label={problem.severity} />
              <span className="problem-message">{problem.message}</span>
              <span className="problem-location">Ln {problem.line}, Col {problem.column}</span>
              <span className="problem-source">{problem.source}</span>
            </button>
            <button className="icon-button" aria-label="Copy problem" title="Copy problem" onClick={() => void copy(details, 'Problem copied.')}>
              <Copy size={13} />
            </button>
          </div>
          {expanded && <pre className="problem-details">{JSON.stringify(details, null, 2)}</pre>}
        </div>;
      })}
    </>}
    {menu && <div key={menu.key} ref={menuRef} className="terminal-menu file-menu" role="menu" aria-label={menu.problem ? 'Problem actions' : 'File problem actions'}
      style={{ left: menu.left, top: menu.top }} onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
          items.find(item => item !== event.currentTarget.ownerDocument.activeElement)?.focus();
        }
      }}>
      <button autoFocus role="menuitem" onClick={() => {
        if (menu.problem) setExpandedProblem(menuExpanded ? '' : menu.key);
        else setFileExpanded(value => !value);
        closeMenu();
      }}>
        {menuExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {menuExpanded ? 'Collapse' : 'Expand'} {menu.problem ? 'details' : 'group'}
      </button>
      <button role="menuitem" onClick={() => {
        closeMenu();
        if (menu.problem) void copy({ file, ...problemDetails(menu.problem) }, 'Problem copied.');
        else copyAll();
      }}><Copy size={13} /> {menu.problem ? 'Copy problem' : 'Copy all'}</button>
    </div>}
  </section>;
}
