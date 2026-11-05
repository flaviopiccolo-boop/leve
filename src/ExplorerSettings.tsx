import type { CSSProperties } from 'react';
import ExplorerEntryIcons from './ExplorerEntryIcons';
import { explorerIconStyles, type ExplorerPreferences } from './explorerPreferences';
import { gitStatuses } from './Git';
import { sortEntries, type FileEntry } from './workspace';

interface SampleEntry extends FileEntry {
  status?: 'M' | '?';
  children?: SampleEntry[];
}

const sampleEntries: SampleEntry[] = [
  { name: 'src', path: 'src', directory: true, children: [
    { name: 'main.py', path: 'src/main.py', directory: false, status: 'M' },
    { name: 'settings.json', path: 'src/settings.json', directory: false },
  ] },
  { name: 'logo.png', path: 'logo.png', directory: false, status: '?' },
  { name: 'package.json', path: 'package.json', directory: false },
  { name: 'README.md', path: 'README.md', directory: false },
];

function PreviewEntries({ entries, preferences, depth = 0 }: { entries: SampleEntry[]; preferences: ExplorerPreferences; depth?: number }) {
  return <>{sortEntries([...entries], preferences.foldersFirst).map(entry => {
    const status = preferences.gitIndicators ? entry.status : undefined;
    return <div key={entry.path}>
      <div className="tree-item" style={{ '--tree-indent': `${depth * 15}px` } as CSSProperties}>
        <ExplorerEntryIcons name={entry.name} directory={entry.directory} expanded={!!entry.children} style={preferences.icons} />
        <span className="tree-name" data-git-status={status}>{entry.name}</span>
        {status && <span className="tree-git-badge" data-git-status={status} title={gitStatuses[status].label}>{gitStatuses[status].badge}</span>}
      </div>
      {entry.children && <PreviewEntries entries={entry.children} preferences={preferences} depth={depth + 1} />}
    </div>;
  })}</>;
}

const toggleOptions = [
  ['indentGuides', 'Indent guides', 'Mark each level of nested folders.'],
  ['foldersFirst', 'Folders first', 'List folders above files.'],
  ['gitIndicators', 'Git indicators', 'Show status colors and badges.'],
] as const;

export default function ExplorerSettings({ preferences, onChange }: {
  preferences: ExplorerPreferences;
  onChange: (preferences: ExplorerPreferences) => void;
}) {
  return <div className="settings-explorer">
    <div>
      <div className="settings-row">
        <div><label htmlFor="explorer-icon-style">File icon style</label><p>Choose how files and folders are represented.</p></div>
        <select id="explorer-icon-style" value={preferences.icons} onChange={event => onChange({ ...preferences, icons: event.target.value as ExplorerPreferences['icons'] })}>
          {Object.entries(explorerIconStyles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="settings-row">
        <div><label htmlFor="explorer-density">Row density</label><p>Change the spacing between entries.</p></div>
        <select id="explorer-density" value={preferences.density} onChange={event => onChange({ ...preferences, density: event.target.value === 'compact' ? 'compact' : 'comfortable' })}>
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </div>
      {toggleOptions.map(([key, label, description]) => <div className="settings-row" key={key}>
        <div><label htmlFor={`explorer-${key}`}>{label}</label><p>{description}</p></div>
        <input id={`explorer-${key}`} className="settings-switch" type="checkbox" checked={preferences[key]}
          onChange={event => onChange({ ...preferences, [key]: event.target.checked })} />
      </div>)}
    </div>
    <div className="settings-explorer-preview" role="region" aria-label="Explorer preview" data-density={preferences.density} data-indent-guides={preferences.indentGuides}>
      <h4>Live preview</h4>
      <PreviewEntries entries={sampleEntries} preferences={preferences} />
    </div>
  </div>;
}
