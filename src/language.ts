import { Channel, invoke } from '@tauri-apps/api/core';
import type { LSPClient, Transport } from '@codemirror/lsp-client';

export type ServerKind = 'python' | 'typescript';
export const languageFeatures = {
  python: 'Python',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  eslint: 'ESLint',
} as const;
export type LanguageFeature = keyof typeof languageFeatures;
export type LanguageOptions = Record<LanguageFeature, boolean>;
export const languageFeature = (id: string) => {
  if (id === 'python') return 'python';
  if (id.startsWith('typescript')) return 'typescript';
  if (id.startsWith('javascript')) return 'javascript';
  return null;
};
export type Definition = { uri: string; line: number; character: number };
export type Problem = {
  path: string; line: number; column: number; message: string;
  severity: 'error' | 'warning' | 'info' | 'hint'; source?: string;
};

const languageIds: Record<string, string> = {
  py: 'python', pyi: 'python',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
};
export function languageId(path: string) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return Object.hasOwn(languageIds, extension) ? languageIds[extension] : '';
}
export function languageError(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}

type ServerEvent = { kind: 'message'; message: string } | { kind: 'closed'; error: string };
type ServerInfo = { rootUri: string; pythonPath: string | null };
export type LintMessage = {
  line?: number; column?: number; endLine?: number; endColumn?: number;
  severity: number; message: string; ruleId?: string;
};

export class LanguageWorkspace {
  private readonly connections = new Map<ServerKind, { client: Promise<LSPClient>; controller: AbortController }>();
  private readonly errors = new Map<ServerKind, string>();
  private lintQueue = Promise.resolve();
  private closed = false;

  constructor(readonly root: string, private readonly report: (message: string) => void) {}

  async document(path: string, id: string) {
    if (this.closed) return null;
    const kind = id === 'python' ? 'python' : 'typescript';
    let connection = this.connections.get(kind);
    if (!connection) {
      const controller = new AbortController();
      connection = { client: this.connect(kind, controller.signal), controller };
      this.connections.set(kind, connection);
      void connection.client.catch(error => {
        if (!controller.signal.aborted) {
          const message = languageError(error);
          this.errors.set(kind, message);
          this.report(message);
        }
      });
    }
    const client = await connection.client;
    if (connection.controller.signal.aborted || !client.serverCapabilities) return null;
    const uri = await invoke<string>('lsp_document', { path, expectedRoot: this.root });
    return connection.controller.signal.aborted ? null : client.plugin(uri, id);
  }

  errorFor(id: string) {
    return this.errors.get(id === 'python' ? 'python' : 'typescript');
  }

  lint(path: string, content: string, signal: AbortSignal) {
    const result = this.lintQueue.then(() => {
      if (this.closed || signal.aborted) return [];
      return invoke<LintMessage[]>('eslint_check', { path, content, expectedRoot: this.root });
    });
    this.lintQueue = result.then(() => {}, () => {});
    return result;
  }

  resolve(uri: string) {
    return invoke<string>('lsp_resolve', { uri, expectedRoot: this.root });
  }

  close() {
    this.closed = true;
    for (const kind of this.connections.keys()) this.stop(kind);
  }

  stop(kind: ServerKind) {
    this.connections.get(kind)?.controller.abort();
    this.connections.delete(kind);
    this.errors.delete(kind);
  }

  private async connect(kind: ServerKind, signal: AbortSignal): Promise<LSPClient> {
    const { createClient } = await import('./lspClient');
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const handlers = new Set<(message: string) => void>();
    const output = new Channel<ServerEvent>();
    let client: LSPClient | undefined;
    let info: ServerInfo | undefined;
    let stopped = false;
    let initialized = false;
    let failure: Error | undefined;
    let rejectStartup: ((error: Error) => void) | undefined;
    let pending = Promise.resolve();
    const stopProcess = () => void invoke('lsp_stop', { kind, id }).catch(() => {});
    const stop = () => {
      if (stopped) return;
      stopped = true;
      handlers.clear();
      if (initialized) client?.disconnect();
      rejectStartup?.(failure ?? new Error('Language support was disabled.'));
      stopProcess();
    };
    signal.addEventListener('abort', stop, { once: true });
    const fail = (error: unknown) => {
      if (stopped) return;
      failure = new Error(languageError(error));
      stop();
      if (initialized && !this.closed && !signal.aborted) {
        this.errors.set(kind, failure.message);
        this.report(failure.message);
      }
    };
    const transport: Transport = {
      send: message => {
        pending = pending.then(async () => {
          if (!stopped) await invoke('lsp_send', { kind, id, message });
        }).catch(fail);
      },
      subscribe: handler => { handlers.add(handler); },
      unsubscribe: handler => { handlers.delete(handler); },
    };
    output.onmessage = event => {
      if (stopped) return;
      if (event.kind === 'closed') {
        fail(event.error);
        return;
      }
      try {
        const request = JSON.parse(event.message);
        if (info && request.id != null && request.method) {
          const settings: Record<string, object> = {
            python: info.pythonPath ? { pythonPath: info.pythonPath } : {},
            'python.analysis': { diagnosticMode: 'openFilesOnly' },
          };
          let result: unknown;
          if (request.method === 'workspace/configuration') {
            result = request.params.items.map((item: { section?: string }) => settings[item.section ?? ''] ?? {});
          } else if (request.method === 'workspace/workspaceFolders') {
            result = [{ uri: info.rootUri, name: 'Project' }];
          } else if (request.method === 'client/registerCapability' || request.method === 'client/unregisterCapability') {
            result = null;
          }
          if (result !== undefined) {
            transport.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
            return;
          }
        }
        for (const handler of handlers) handler(event.message);
      } catch (error) {
        fail(error);
      }
    };

    try {
      info = await invoke<ServerInfo>('lsp_start', { kind, id, expectedRoot: this.root, output });
      if (signal.aborted || stopped) {
        stopProcess();
        throw failure ?? new Error('The language server stopped before initialization.');
      }
      client = createClient(info.rootUri, kind).connect(transport);
      await Promise.race([
        client.initializing,
        new Promise<never>((_, reject) => { rejectStartup = reject; }),
      ]);
      rejectStartup = undefined;
      if (stopped || signal.aborted) throw failure ?? new Error('The language server stopped during initialization.');
      initialized = true;
      if (kind === 'python') {
        client.notification('workspace/didChangeConfiguration', { settings: {
          python: { pythonPath: info.pythonPath ?? undefined, analysis: { diagnosticMode: 'openFilesOnly' } },
        } });
      }
      return client;
    } catch (error) {
      stop();
      throw error;
    }
  }
}
