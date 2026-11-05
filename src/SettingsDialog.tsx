import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Code2, FolderTree, Keyboard, LayoutTemplate, Palette, Search, X } from 'lucide-react';
import ExplorerSettings from './ExplorerSettings';
import type { ExplorerPreferences } from './explorerPreferences';
import { languageFeatures, type LanguageFeature, type LanguageOptions } from './language';
import { themePresets, useTheme, type Theme } from './theme';

const sections = [
  { id: 'appearance', label: 'Appearance', icon: Palette, keywords: 'color theme light dark midnight forest paper' },
  { id: 'layout', label: 'Workspace layout', icon: LayoutTemplate, keywords: 'panels sidebar reset' },
  { id: 'explorer', label: 'Explorer', icon: FolderTree, keywords: 'file folder icons colorful monochrome density compact indentation guides sort git indicators' },
  { id: 'language', label: 'Language support', icon: Code2, keywords: 'python typescript javascript eslint diagnostics' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, keywords: 'find search save terminal completion definition' },
] as const;

const shortcuts = [
  ['Find a file', 'Ctrl+P'], ['Search project contents', 'Ctrl+Shift+F'], ['Search in the editor', 'Ctrl+F'],
  ['Save file', 'Ctrl+S'], ['New terminal', 'Ctrl+`'], ['Complete code', 'Ctrl+Space'],
  ['Go to definition', 'F12'], ['Show diagnostics', 'Ctrl+Shift+M'],
];

interface Props {
  explorerPreferences: ExplorerPreferences;
  onExplorerChange: (preferences: ExplorerPreferences) => void;
  languageOptions: LanguageOptions;
  hasProject: boolean;
  onLanguageChange: (feature: LanguageFeature, enabled: boolean) => void;
  onResetLayout: () => void;
  onClose: () => void;
}

export default function SettingsDialog({ explorerPreferences, onExplorerChange, languageOptions, hasProject, onLanguageChange, onResetLayout, onClose }: Props) {
  const { theme, setTheme } = useTheme();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<(typeof sections)[number]['id']>('appearance');
  const [query, setQuery] = useState('');
  const matches = sections.filter(section => `${section.label} ${section.keywords}`.toLowerCase().includes(query.trim().toLowerCase()));
  const active = matches.find(section => section.id === selected) ?? matches[0];

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return <dialog ref={dialogRef} className="settings-modal" aria-labelledby="settings-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="modal-heading settings-header">
      <h2 id="settings-title">Settings</h2>
      <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="settings-body">
      <nav className="settings-nav" aria-label="Settings sections">
        <label className="settings-search"><Search size={15} aria-hidden="true" />
          <input type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        {matches.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={active?.id === id ? 'page' : undefined} onClick={() => setSelected(id)}>
          <Icon size={16} aria-hidden="true" />{label}
        </button>)}
      </nav>
      <section className="settings-content" key={active?.id} aria-labelledby="settings-section-title">
        <h3 id="settings-section-title">{active?.label ?? 'No matching settings'}</h3>
        {!active && <p>Try a section name or a term like theme, terminal, or Python.</p>}
        {active?.id === 'appearance' && <>
          <p>Choose a color theme for the workspace, editor, and terminal.</p>
          <div className="settings-theme" role="radiogroup" aria-label="Color theme">
            {(Object.keys(themePresets) as Theme[]).map(mode => {
              const { label, description } = themePresets[mode];
              return <label className="theme-option" key={mode}>
                <input type="radio" name="theme" aria-label={label} checked={theme === mode} onChange={() => setTheme(mode)} />
                <span className="theme-card">
                  <span className="theme-preview" data-theme={mode} aria-hidden="true">
                    <span className="theme-preview-rail" />
                    <span className="theme-preview-editor"><i /><i /><i /></span>
                  </span>
                  <span className="theme-card-label">{label}{theme === mode && <Check size={14} aria-hidden="true" />}</span>
                  <span className="theme-card-description">{description}</span>
                </span>
              </label>;
            })}
          </div>
        </>}
        {active?.id === 'layout' && <>
          <p>Drag tabs to move panels. Drop at the edge to split an area, or onto a group to combine tabs.</p>
          <div className="settings-row">
            <div><h4>Default layout</h4><p>Restore the default panel arrangement. This closes open terminal sessions and keeps your files and edits.</p></div>
            <button type="button" className="button" onClick={onResetLayout}><LayoutTemplate size={15} />Reset layout</button>
          </div>
        </>}
        {active?.id === 'explorer' && <ExplorerSettings preferences={explorerPreferences} onChange={onExplorerChange} />}
        {active?.id === 'language' && <>
          <p>{hasProject ? 'These settings apply to the open project. Enable them only for projects you trust, as analysis tools can run project configuration and plugins.' : 'Open a local project to enable language support.'}</p>
          {(Object.keys(languageFeatures) as LanguageFeature[]).map(feature => <div className="settings-row" key={feature}>
            <div><label htmlFor={`settings-language-${feature}`}>{languageFeatures[feature]}</label>
              <p>{feature === 'eslint' ? 'Use the project’s ESLint installation to check active JavaScript and TypeScript files.' : 'Enable code completion, diagnostics, and navigation.'}</p>
            </div>
            <input id={`settings-language-${feature}`} className="settings-switch" type="checkbox" checked={languageOptions[feature]} disabled={!hasProject} onChange={event => onLanguageChange(feature, event.target.checked)} />
          </div>)}
        </>}
        {active?.id === 'shortcuts' && <dl className="settings-shortcut-list">
          {shortcuts.map(([label, key]) => <div className="settings-row" key={label}><dt>{label}</dt><dd><kbd>{key}</kbd></dd></div>)}
        </dl>}
      </section>
    </div>
  </dialog>;
}
