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

// No prototype, so names such as "constructor" are ordinary demo files.
const demo: Record<string, string> = Object.assign(Object.create(null), demoFiles);
const demoFolders = new Set<string>();
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
  for (const file of Object.keys(demo)) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...rest] = file.slice(prefix.length).split('/');
    entries.set(name, { name, path: prefix + name, directory: rest.length > 0 });
  }
  for (const folder of demoFolders) {
    if (!folder.startsWith(prefix)) continue;
    const [name] = folder.slice(prefix.length).split('/');
    entries.set(name, { name, path: prefix + name, directory: true });
  }
  return sortEntries([...entries.values()]);
}
export async function readFile(path: string): Promise<string> {
  return native && workspaceSelected ? invoke<string>('read_file', { path }) : demo[path];
}
export async function writeFile(file: OpenFile): Promise<void> {
  if (native && workspaceSelected) await invoke('write_file', { path: file.path, content: file.content, expected: file.saved });
  else demo[file.path] = file.content;
}
export const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const joinPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
/** The path after moving `from` to `to`, or null when `path` is unaffected. */
export function movedPath(path: string, from: string, to: string) {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}
/** Keep this in sync with `validate_name` in `src-tauri/src/files.rs`. Returns the problem, if any. */
export function validateName(name: string) {
  if (!name) return 'Enter a name.';
  if (name === '.' || name === '..') return 'This name is not allowed.';
  if ([...name].length > 255) return 'The name is too long.';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/.test(name)) return 'A name cannot contain < > : " / \\ | ? *';
  if (/[ .]$/.test(name)) return 'A name cannot end with a space or period.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) return 'Windows reserves this name.';
  return '';
}
const demoExists = (path: string) => path in demo || demoFolders.has(path) || Object.keys(demo).some(file => file.startsWith(`${path}/`)) || [...demoFolders].some(folder => folder.startsWith(`${path}/`));
export async function createPath(parent: string, name: string, directory: boolean): Promise<string> {
  const path = joinPath(parent, name);
  if (native && workspaceSelected) await invoke(directory ? 'create_directory' : 'create_file', { path });
  else {
    const problem = validateName(name) || (demoExists(path) ? 'A file or folder with this name already exists.' : '');
    if (problem) throw new Error(problem);
    if (directory) demoFolders.add(path); else demo[path] = '';
  }
  return path;
}
export async function renamePath(path: string, name: string): Promise<string> {
  if (native && workspaceSelected) return invoke<string>('rename_path', { path, newName: name });
  const renamed = joinPath(parentPath(path), name);
  const problem = validateName(name) || (demoExists(renamed) ? 'A file or folder with this name already exists.' : '');
  if (problem) throw new Error(problem);
  for (const file of Object.keys(demo)) {
    const moved = movedPath(file, path, renamed);
    if (moved) { demo[moved] = demo[file]; delete demo[file]; }
  }
  for (const folder of [...demoFolders]) {
    const moved = movedPath(folder, path, renamed);
    if (moved) { demoFolders.delete(folder); demoFolders.add(moved); }
  }
  return renamed;
}
export async function deletePath(path: string): Promise<void> {
  if (native && workspaceSelected) { await invoke('delete_path', { path }); return; }
  for (const file of Object.keys(demo)) if (movedPath(file, path, '') !== null) delete demo[file];
  for (const folder of [...demoFolders]) if (movedPath(folder, path, '') !== null) demoFolders.delete(folder);
  // Demo folders exist only through their files, so keep an emptied parent visible.
  if (parentPath(path)) demoFolders.add(parentPath(path));
}
/** True when deletion goes to the operating system's Recycle Bin. */
export const usesRecycleBin = () => native && workspaceSelected;
export function fileName(path: string) { return path.split(/[\\/]/).pop() || path; }
export function languageName(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ py: 'Python', ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', json: 'JSON', md: 'Markdown', css: 'CSS', html: 'HTML' } as Record<string, string>)[ext || ''] || 'Plain text';
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
