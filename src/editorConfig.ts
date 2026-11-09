import { useEffect, useState } from 'react';
import { Minimatch } from 'minimatch';
import type { EditorPreferences, IndentStyle } from './editorPreferences';
import { readFile } from './workspace';

const indentationKeys = ['indent_style', 'indent_size', 'tab_width'] as const;
type IndentationKey = (typeof indentationKeys)[number];
type Properties = Partial<Record<IndentationKey, string>>;
export interface FileIndentation { indentStyle: IndentStyle; indentSize: number; tabWidth: number }

function parseConfig(content: string) {
  let root = false;
  let current: Properties | undefined;
  const sections: { glob: Minimatch; properties: Properties }[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const pattern = line.slice(1, -1);
      current = {};
      if (pattern && !pattern.endsWith('/') && pattern.length <= 1024) {
        sections.push({ glob: new Minimatch(pattern.replace(/^\//, ''), {
          dot: true, matchBase: !pattern.includes('/'), nonegate: true, nocomment: true, noext: true, platform: 'linux',
        }), properties: current });
      }
      continue;
    }
    const pair = /^([^=]+)=(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].trim().toLowerCase();
    const value = pair[2].trim().toLowerCase();
    if (!current && key === 'root') root = value === 'true';
    if (current && indentationKeys.some(property => property === key)) current[key as IndentationKey] = value;
  }
  return { root, sections };
}

export async function readEditorConfigs(paths: string[]) {
  const cache = new Map<string, Promise<ReturnType<typeof parseConfig> | undefined>>();
  const results = await Promise.all(paths.map(async path => {
    const directories = path.split('/').slice(0, -1);
    const properties: Properties = {};
    for (let depth = directories.length; depth >= 0; depth--) {
      const directory = directories.slice(0, depth).join('/');
      let pending = cache.get(directory);
      if (!pending) {
        pending = readFile(directory ? `${directory}/.editorconfig` : '.editorconfig').then(parseConfig).catch(() => undefined);
        cache.set(directory, pending);
      }
      const config = await pending;
      if (!config) continue;
      const relativePath = path.split('/').slice(depth).join('/');
      for (const { glob, properties: section } of [...config.sections].reverse()) {
        if (!glob.match(relativePath)) continue;
        for (const key of indentationKeys) properties[key] ??= section[key];
      }
      if (config.root) break;
    }
    return [path, properties] as const;
  }));
  return new Map(results);
}

export function useEditorConfigs(root: string | null, paths: string, revision: string) {
  const [loaded, setLoaded] = useState<{ root: string; configs: Map<string, Properties> }>();
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    void readEditorConfigs(JSON.parse(paths)).then(configs => {
      if (!cancelled) setLoaded({ root, configs });
    });
    return () => { cancelled = true; };
  }, [root, paths, revision]);
  return loaded?.root === root ? loaded.configs : undefined;
}

function width(value?: string) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const size = Number(value);
  return size >= 1 && size <= 256 ? size : undefined;
}

export function resolveIndentation(defaults: EditorPreferences, properties?: Properties): FileIndentation {
  const style = properties?.indent_style;
  const indentStyle = style === 'tab' ? 'tabs' : style === 'space' ? 'spaces' : defaults.indentStyle;
  const size = width(properties?.indent_size);
  const tabWidth = width(properties?.tab_width) ?? size ?? defaults.indentSize;
  const indentSize = size ?? (properties?.indent_size === 'tab' || style === 'tab' ? tabWidth : defaults.indentSize);
  // CodeMirror can represent a unit made entirely of tabs or entirely of spaces.
  return { indentStyle: indentSize % tabWidth === 0 ? indentStyle : 'spaces', indentSize, tabWidth };
}
