import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export interface FileEntry { name: string; path: string; directory: boolean }
export interface OpenFile { path: string; name: string; content: string; saved: string }
export const native = isTauri();

export const demoFiles: Record<string, string> = {
  'src/main.py': `from services.greeting import greet\n\n\ndef main():\n    message = greet("world")\n    print(message)\n\n\nif __name__ == "__main__":\n    main()\n`,
  'src/services/greeting.py': `def greet(name: str) -> str:\n    """A small idea, a good start."""\n    return f"Hello, {name}!"\n`,
  'README.md': `# Your next project starts here\n\nWelcome to Leve.\n\n- Drag tabs to rearrange panels.\n- Open files from the tree on the left.\n- Use Ctrl+S to save and Ctrl+P to find files.\n\nThis is a demo folder. To edit real files,\nopen a folder in the desktop app.\n`,
  '.gitignore': '__pycache__/\n.venv/\n',
  'requirements.txt': '# Add project dependencies here.\n',
};

let demo = { ...demoFiles };
const demoFolders = new Set(['src', 'src/services']);
let workspaceSelected = false;
export function sortEntries(entries: FileEntry[]) {
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}
export async function pickWorkspace(): Promise<string | null> {
  if (!native) return null;
  const path = await open({ directory: true, multiple: false, title: 'Open project folder' });
  return path;
}
export async function activateWorkspace(path: string): Promise<string> {
  const root = await invoke<string>('set_workspace', { path });
  workspaceSelected = true;
  return root;
}
export async function listFiles(path = ''): Promise<FileEntry[]> {
  if (native && workspaceSelected) return sortEntries(await invoke<FileEntry[]>('list_directory', { path }));
  const prefix = path ? `${path}/` : '';
  const entries = new Map<string, FileEntry>();
  for (const folder of demoFolders) {
    if (folder.startsWith(prefix) && folder !== path) {
      const name = folder.slice(prefix.length).split('/')[0];
      entries.set(name, { name, path: prefix + name, directory: true });
    }
  }
  for (const file of Object.keys(demo)) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...rest] = file.slice(prefix.length).split('/');
    entries.set(name, { name, path: prefix + name, directory: rest.length > 0 });
  }
  return sortEntries([...entries.values()]);
}
export async function readFile(path: string): Promise<string> {
  if (native && workspaceSelected) return invoke<string>('read_file', { path });
  if (!(path in demo)) throw new Error('File not found.');
  return demo[path];
}
export async function writeFile(file: OpenFile): Promise<void> {
  if (native && workspaceSelected) await invoke('write_file', { path: file.path, content: file.content, expected: file.saved });
  else demo[file.path] = file.content;
}
export function fileName(path: string) { return path.split(/[\\/]/).pop() || path; }
export const withinEntry = (path: string, parent: string) => path.toLowerCase() === parent.toLowerCase() || path.toLowerCase().startsWith(`${parent.toLowerCase()}/`);
export type FileOperation = { kind: 'file'; parent: string } | { kind: 'folder'; parent: string } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete'; entry: FileEntry };

export async function mutateEntry(operation: FileOperation, name: string, expectedRoot: string | null): Promise<string> {
  if (native) {
    if (!expectedRoot) throw new Error('Open a project folder first.');
    if (operation.kind === 'delete') { await invoke('delete_entry', { path: operation.entry.path, expectedRoot }); return ''; }
    if (operation.kind === 'rename') return invoke('rename_entry', { path: operation.entry.path, name, expectedRoot });
    return invoke('create_entry', { parent: operation.parent, name, directory: operation.kind === 'folder', expectedRoot });
  }
  if (operation.kind === 'delete') {
    for (const path of Object.keys(demo)) if (withinEntry(path, operation.entry.path)) delete demo[path];
    for (const path of demoFolders) if (withinEntry(path, operation.entry.path)) demoFolders.delete(path);
    return '';
  }
  if (!name || name.trim() !== name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw new Error('Use a valid Windows file or folder name.');
  const parent = operation.kind === 'rename' ? operation.entry.path.split('/').slice(0, -1).join('/') : operation.parent;
  const target = parent ? `${parent}/${name}` : name;
  if (operation.kind === 'rename' && target === operation.entry.path) return target;
  if ([...Object.keys(demo), ...demoFolders].some(path => path.toLowerCase() === target.toLowerCase())) throw new Error('A file or folder with that name already exists.');
  if (operation.kind === 'rename') {
    const source = operation.entry.path;
    for (const path of Object.keys(demo)) if (withinEntry(path, source)) { demo[target + path.slice(source.length)] = demo[path]; delete demo[path]; }
    for (const path of [...demoFolders]) if (withinEntry(path, source)) { demoFolders.delete(path); demoFolders.add(target + path.slice(source.length)); }
  } else if (operation.kind === 'folder') demoFolders.add(target);
  else demo[target] = '';
  return target;
}
export function languageName(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ py: 'Python', pyi: 'Python', ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX', json: 'JSON', md: 'Markdown', css: 'CSS', html: 'HTML' } as Record<string, string>)[ext || ''] || 'Plain text';
}
export async function indexFiles(path = '', depth = 0): Promise<FileEntry[]> {
  if (depth > 15) return [];
  const result: FileEntry[] = [];
  for (const entry of await listFiles(path)) {
    if (entry.directory && !['node_modules', '.git', 'target', '.venv', '__pycache__', 'dist'].includes(entry.name)) {
      result.push(...await indexFiles(entry.path, depth + 1));
    } else if (!entry.directory) result.push(entry);
    if (result.length >= 5000) break;
  }
  return result.slice(0, 5000);
}

export interface ContentMatch { path: string; line: number; column: number; length: number; preview: string; matchedText: string }
export interface ContentResults { matches: ContentMatch[]; scanned: number; skipped: number; limit: string | null }
export async function searchContent(query: string, caseSensitive: boolean, id: string, root: string | null): Promise<ContentResults> {
  if (native) return invoke('search_content', { query, caseSensitive, id, expectedRoot: root });
  const result: ContentResults = { matches: [], scanned: 0, skipped: 0, limit: null };
  const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
  for (const [path, content] of Object.entries(demo)) {
    if (path.split('/').some(part => ['.git', 'node_modules', 'target', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.idea'].includes(part.toLowerCase()))) continue;
    result.scanned += 1;
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) for (const found of line.matchAll(matcher)) {
      if (result.matches.length >= 500) { result.limit = 'Result limit reached (500). Narrow your search.'; return result; }
      const column = found.index!;
      result.matches.push({ path, line: index + 1, column: column + 1, length: found[0].length, preview: line.slice(Math.max(0, column - 60), column + 180), matchedText: found[0] });
    }
  }
  return result;
}
export function cancelSearch(id: string) { if (native) void invoke('cancel_search', { id }).catch(() => {}); }
