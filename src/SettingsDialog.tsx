import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Code2, FileCode2, FolderTree, Keyboard, LayoutTemplate, Palette, Search, X } from 'lucide-react';
import ExplorerSettings from './ExplorerSettings';
import type { ExplorerPreferences } from './explorerPreferences';
import { indentSizes, type EditorPreferences } from './editorPreferences';
import { languageFeatures, type LanguageFeature, type LanguageOptions } from './language';
import { themePresets, useTheme, type Theme } from './theme';

const sections = [
  { id: 'appearance', label: 'Appearance', icon: Palette, keywords: 'color theme light dark midnight forest paper' },
  { id: 'editor', label: 'Editor', icon: FileCode2, keywords: 'code editorconfig project indentation size tabs spaces guides lines solid dotted rainbow soft colors' },
  { id: 'explorer', label: 'Explorer', icon: FolderTree, keywords: 'file folder icons colorful monochrome density compact indentation guides sort git indicators' },
  { id: 'language', label: 'Language support', icon: Code2, keywords: 'python typescript javascript eslint diagnostics' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, keywords: 'find search save terminal completion definition indent outdent tab focus' },
  { id: 'layout', label: 'Workspace layout', icon: LayoutTemplate, keywords: 'panels sidebar reset' },
] as const;
export type SettingsSection = (typeof sections)[number]['id'];

const shortcuts = [
  ['Find a file', 'Ctrl+P'], ['Search project contents', 'Ctrl+Shift+F'], ['Search in the editor', 'Ctrl+F'],
  ['Save file', 'Ctrl+S'], ['Save All', 'Ctrl+Alt+S'], ['Save As', 'Ctrl+Shift+S'], ['New terminal', 'Ctrl+`'], ['Complete code', 'Ctrl+Space'],
  ['Go to definition', 'F12'], ['Show diagnostics', 'Ctrl+Shift+M'],
  ['Indent selected lines', 'Tab or Ctrl+]'], ['Outdent selected lines', 'Shift+Tab or Ctrl+['],
  ['Toggle Tab focus mode', 'Ctrl+M'],
];

interface Props {
  initialSection: SettingsSection;
  versionLabel: string;
  explorerPreferences: ExplorerPreferences;
  onExplorerChange: (preferences: ExplorerPreferences) => void;
  editorPreferences: EditorPreferences;
  onEditorChange: (preferences: EditorPreferences) => void;
  languageOptions: LanguageOptions;
  hasProject: boolean;
  onLanguageChange: (feature: LanguageFeature, enabled: boolean) => void;
  onResetLayout: () => void;
  onClose: () => void;
}

export default function SettingsDialog({ initialSection, versionLabel, explorerPreferences, onExplorerChange, editorPreferences, onEditorChange, languageOptions, hasProject, onLanguageChange, onResetLayout, onClose }: Props) {
  const { theme, setTheme } = useTheme();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(initialSection);
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
      <div className="settings-title"><h2 id="settings-title">Settings</h2><span>{versionLabel}</span></div>
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
        {active?.id === 'editor' && <div className="settings-editor">
          <div className="settings-row">
            <div><label htmlFor="use-editorconfig">Use project indentation rules (.editorconfig)</label><p>Tab overrides in the status bar take priority. In Auto mode, project rules take priority over the defaults below.</p></div>
            <input id="use-editorconfig" className="settings-switch" type="checkbox" checked={editorPreferences.useEditorConfig} onChange={event => onEditorChange({ ...editorPreferences, useEditorConfig: event.target.checked })} />
          </div>
          <div className="settings-row">
            <div><label htmlFor="indent-style">Default indentation style</label><p>Choose what the editor inserts when using the default indentation.</p></div>
            <select id="indent-style" value={editorPreferences.indentStyle} onChange={event => onEditorChange({ ...editorPreferences, indentStyle: event.target.value === 'tabs' ? 'tabs' : 'spaces' })}>
              <option value="spaces">Spaces</option><option value="tabs">Tabs</option>
            </select>
          </div>
          <div className="settings-row">
            <div><label htmlFor="indent-size">Default indentation size</label><p>Set the default number of columns per indentation level.</p></div>
            <select id="indent-size" value={editorPreferences.indentSize} onChange={event => {
              const indentSize = indentSizes.find(size => String(size) === event.target.value);
              if (indentSize !== undefined) onEditorChange({ ...editorPreferences, indentSize });
            }}>
              {indentSizes.map(size => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
          <div className="settings-row">
            <div><label htmlFor="indent-guides">Indentation guides</label><p>Show a vertical guide for each level of indentation in the code editor.</p></div>
            <select id="indent-guides" value={editorPreferences.indentGuides} onChange={event => onEditorChange({ ...editorPreferences, indentGuides: event.target.value as EditorPreferences['indentGuides'] })}>
              <option value="off">Off</option><option value="solid">Solid</option><option value="dotted">Dotted</option>
            </select>
          </div>
          <div className="settings-row">
            <div><label htmlFor="indent-guide-palette">Guide colors</label><p>Use the theme’s neutral color or alternate soft colors by indentation level.</p></div>
            <select id="indent-guide-palette" value={editorPreferences.indentGuidePalette} disabled={editorPreferences.indentGuides === 'off'} onChange={event => onEditorChange({ ...editorPreferences, indentGuidePalette: event.target.value as EditorPreferences['indentGuidePalette'] })}>
              <option value="neutral">Neutral</option><option value="soft">Soft colors</option>
            </select>
          </div>
        </div>}
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
