const KEY = 'leve.projects.v1';

// Windows paths are case insensitive; keep the display path returned by Tauri.
const identity = (path: string) => path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function loadProjects(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    const seen = new Set<string>();
    return stored.filter((path): path is string => {
      if (typeof path !== 'string' || !path.trim() || seen.has(identity(path))) return false;
      seen.add(identity(path)); return true;
    });
  } catch { return []; }
}

export function rememberProject(path: string): string[] {
  const projects = [path, ...loadProjects().filter(item => identity(item) !== identity(path))];
  localStorage.setItem(KEY, JSON.stringify(projects));
  return projects;
}

export const sameProject = (left: string, right: string) => identity(left) === identity(right);
