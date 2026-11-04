import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export interface FileEntry { name: string; path: string; directory: boolean }
export interface OpenFile { path: string; name: string; content: string; saved: string }
export const native = isTauri();

export const demoFiles: Record<string, string> = {
  'src/main.py': `from services.greeting import greet\n\n\ndef main():\n    message = greet("mundo")\n    print(message)\n\n\nif __name__ == "__main__":\n    main()\n`,
  'src/services/greeting.py': `def greet(name: str) -> str:\n    """Uma pequena ideia, um bom começo."""\n    return f"Olá, {name}!"\n`,
  'README.md': `# Seu próximo projeto começa aqui\n\nBem-vindo ao Leve.\n\n- Arraste as abas para reorganizar os painéis.\n- Abra arquivos pela árvore à esquerda.\n- Use Ctrl+S para salvar e Ctrl+P para encontrar arquivos.\n\nEsta é uma pasta de demonstração. Para editar arquivos reais,\nabra uma pasta no aplicativo desktop.\n`,
  '.gitignore': '__pycache__/\n.venv/\n',
  'requirements.txt': '# Adicione as dependências do projeto aqui.\n',
};

let demo = { ...demoFiles };
let workspaceSelected = false;
export function sortEntries(entries: FileEntry[]) {
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}
export async function pickWorkspace(): Promise<string | null> {
  if (!native) return null;
  const path = await open({ directory: true, multiple: false, title: 'Abrir pasta do projeto' });
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
  return sortEntries([...entries.values()]);
}
export async function readFile(path: string): Promise<string> {
  return native && workspaceSelected ? invoke<string>('read_file', { path }) : demo[path];
}
export async function writeFile(file: OpenFile): Promise<void> {
  if (native && workspaceSelected) await invoke('write_file', { path: file.path, content: file.content, expected: file.saved });
  else demo[file.path] = file.content;
}
export function fileName(path: string) { return path.split(/[\\/]/).pop() || path; }
export function languageName(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ py: 'Python', ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', json: 'JSON', md: 'Markdown', css: 'CSS', html: 'HTML' } as Record<string, string>)[ext || ''] || 'Texto';
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
