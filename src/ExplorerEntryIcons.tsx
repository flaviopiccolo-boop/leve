import { Braces, ChevronDown, ChevronRight, Container, Database, File, FileCode2, FileImage, FileJson2, FileText, FileType2, Folder, FolderOpen, GitBranch, Package, Paintbrush, Settings2, Terminal, type LucideIcon } from 'lucide-react';
import type { ExplorerPreferences } from './explorerPreferences';

type FileIcon = [LucideIcon, string];
const genericIcon: FileIcon = [File, 'file-icon'];
const nameIcons = new Map<string, FileIcon>([
  ['dockerfile', [Container, 'tree-icon-blue']],
  ['package.json', [Package, 'tree-icon-gold']],
  ['cargo.toml', [Package, 'tree-icon-gold']],
  ['.gitignore', [GitBranch, 'tree-icon-gold']],
  ['.env', [Settings2, 'tree-icon-purple']],
]);
const extensions = new Map<string, FileIcon>();
const fileKinds: [string, FileIcon][] = [
  ['py pyi', [FileCode2, 'tree-icon-blue']],
  ['ts tsx mts cts', [FileType2, 'tree-icon-blue']],
  ['js jsx mjs cjs', [Braces, 'tree-icon-gold']],
  ['json jsonc', [FileJson2, 'tree-icon-gold']],
  ['md mdx txt rst', [FileText, 'tree-icon-teal']],
  ['png jpg jpeg webp gif svg ico bmp avif', [FileImage, 'tree-icon-green']],
  ['css scss less', [Paintbrush, 'tree-icon-purple']],
  ['yaml yml toml ini conf env', [Settings2, 'tree-icon-purple']],
  ['sh bash ps1 cmd bat', [Terminal, 'tree-icon-green']],
  ['sql db sqlite', [Database, 'tree-icon-teal']],
  ['html xml rs go c cpp h java cs rb php', [FileCode2, 'tree-icon-purple']],
];
for (const [suffixes, icon] of fileKinds) for (const suffix of suffixes.split(' ')) extensions.set(suffix, icon);

export default function ExplorerEntryIcons({ name, directory, expanded, style }: {
  name: string; directory: boolean; expanded?: boolean; style: ExplorerPreferences['icons'];
}) {
  const Arrow = expanded ? ChevronDown : ChevronRight;
  const lowerName = name.toLowerCase();
  let icon: FileIcon;
  if (style === 'standard') {
    icon = directory ? [Folder, 'folder-icon'] : [FileCode2, lowerName.endsWith('.py') ? 'python-icon' : 'file-icon'];
  } else if (directory) {
    icon = [expanded ? FolderOpen : Folder, 'tree-icon-gold'];
  } else {
    const dot = lowerName.lastIndexOf('.');
    const extension = dot > 0 ? lowerName.slice(dot + 1) : '';
    icon = nameIcons.get(lowerName) ?? extensions.get(extension) ?? genericIcon;
  }
  const [Icon, color] = icon;
  return <>
    {directory ? <Arrow size={12} className="tree-chevron" aria-hidden="true" /> : <span className="tree-spacer" aria-hidden="true" />}
    {style !== 'none' && <Icon size={directory ? 15 : 14} aria-hidden="true" className={`tree-entry-icon ${style === 'monochrome' ? 'file-icon' : color}`} />}
  </>;
}
