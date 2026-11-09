import { invoke } from '@tauri-apps/api/core';
import type { IJsonModel } from 'flexlayout-react';
import { native, readFile, type OpenFile } from './workspace';

export interface Session {
  version: 1;
  root: string | null;
  files: OpenFile[];
  activeFile: string;
  layout: IJsonModel;
}

const KEY = 'leve.session.v1';
let writes: Promise<void> = Promise.resolve();

export async function loadSession(): Promise<Session | null> {
  const data = native ? await invoke<Session | null>('session_load') : JSON.parse(localStorage.getItem(KEY) || 'null');
  if (!data) return null;
  if (data.version !== 1 || !Array.isArray(data.files) || data.files.length > 100 ||
      !(data.root === null || typeof data.root === 'string') || typeof data.activeFile !== 'string' || !data.layout ||
      data.files.some((file: OpenFile) => !file || typeof file.path !== 'string' || typeof file.name !== 'string' || typeof file.content !== 'string' || typeof file.saved !== 'string' ||
        (file.lineEnding !== undefined && !['LF', 'CRLF', 'CR'].includes(file.lineEnding)) ||
        (file.image !== undefined && (file.image !== true || file.content !== '' || file.saved !== '')))) {
    throw new Error('Invalid recovery data. The existing snapshot has been preserved.');
  }
  return data;
}

export function saveSession(session: Session): Promise<void> {
  if (!native) {
    localStorage.setItem(KEY, JSON.stringify(session));
    return Promise.resolve();
  }
  const write = writes.catch(() => {}).then(() => invoke<void>('session_save', { session }));
  writes = write;
  return write;
}

export async function restoreFiles(savedFiles: OpenFile[]): Promise<{ files: Record<string, OpenFile>; warnings: string[]; recovered: number }> {
  const files: Record<string, OpenFile> = Object.create(null);
  const warnings: string[] = [];
  let recovered = 0;
  for (const file of savedFiles) {
    if (file.image) {
      // The viewer reloads from disk when its tab is shown.
      files[file.path] = file;
    } else if (file.content !== file.saved) {
      files[file.path] = file;
      recovered += 1;
      try {
        const disk = await readFile(file.path);
        if (disk === file.content) { files[file.path] = { ...file, saved: disk }; recovered -= 1; }
        else if (disk !== file.saved) warnings.push(`${file.name} changed on disk. Recovered edits were kept; saving will check for a conflict.`);
      }
      catch { warnings.push(`${file.name} is unavailable on disk. Its recovered edits were kept.`); }
    } else {
      try {
        const content = await readFile(file.path);
        if (typeof content !== 'string') throw new Error('File not found');
        files[file.path] = { ...file, content, saved: content, lineEnding: content === file.saved ? file.lineEnding : undefined };
      } catch { warnings.push(`${file.name} could not be reopened.`); }
    }
  }
  return { files, warnings, recovered };
}
