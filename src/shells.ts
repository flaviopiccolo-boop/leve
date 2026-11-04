import { invoke } from '@tauri-apps/api/core';
import { native } from './workspace';

export interface ShellProfile { id: string; name: string; available: boolean }

export const previewShells: ShellProfile[] = [
  { id: 'powershell', name: 'PowerShell', available: true },
  { id: 'cmd', name: 'CMD', available: true },
  { id: 'git-bash', name: 'Git Bash', available: true },
  { id: 'pwsh', name: 'PowerShell 7', available: true },
];

export function loadShells(): Promise<ShellProfile[]> {
  return native ? invoke<ShellProfile[]>('list_shells') : Promise.resolve(previewShells);
}
