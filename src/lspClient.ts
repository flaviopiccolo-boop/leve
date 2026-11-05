import { LSPClient, LSPPlugin, serverCompletion, serverDiagnostics } from '@codemirror/lsp-client';
import { forEachDiagnostic, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import type { Definition, LintMessage, ServerKind } from './language';

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Location = { uri: string; range: Range };
type LocationLink = { targetUri: string; targetSelectionRange: Range };
type ServerDiagnostic = { range: Range; message: string; severity?: number; source?: string };

function fileKey(uri: string) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return uri;
    const path = decodeURIComponent(url.pathname).replace(/^\/([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}:`);
    return url.host + path;
  } catch { return uri; }
}

function replaceDiagnostics(view: EditorView, source: string, next: Diagnostic[]) {
  const all = next.map(item => ({ ...item, source }));
  forEachDiagnostic(view.state, (item, from, to) => {
    if (item.source !== source) all.push({ ...item, from, to, source: item.source ?? '' });
  });
  view.dispatch(setDiagnostics(view.state, all));
}

export function clearDiagnostics(view: EditorView, source: 'Language server' | 'ESLint') {
  replaceDiagnostics(view, source, []);
}

export function createClient(rootUri: string, kind: ServerKind) {
  // Keep the package's document synchronization, but merge LSP and ESLint markers.
  const diagnostics = serverDiagnostics();
  return new LSPClient({
    rootUri,
    timeout: 8000,
    initializationOptions: kind === 'typescript'
      ? { disableAutomaticTypingAcquisition: true, tsserver: { useSyntaxServer: 'never' } }
      : undefined,
    sanitizeHTML: html => {
      const template = document.createElement('template');
      template.innerHTML = html;
      const plain = document.createElement('span');
      plain.textContent = template.content.textContent;
      return plain.innerHTML;
    },
    extensions: [serverCompletion(), diagnostics, {
      clientCapabilities: { workspace: { configuration: true, workspaceFolders: true } },
    }],
    notificationHandlers: {
      'textDocument/publishDiagnostics': (client, params: { uri: string; version?: number; diagnostics: ServerDiagnostic[] }) => {
        const file = client.workspace.getFile(params.uri)
          ?? client.workspace.files.find(item => fileKey(item.uri) === fileKey(params.uri));
        const view = file?.getView();
        const plugin = view && LSPPlugin.get(view);
        if (!file || !view || !plugin || (params.version != null && params.version !== file.version)) return true;
        const offset = (position: Position) => plugin.unsyncedChanges.mapPos(plugin.fromPosition(position, plugin.syncedDoc));
        replaceDiagnostics(view, 'Language server', params.diagnostics.slice(0, 500).map(item => ({
          from: offset(item.range.start),
          to: offset(item.range.end),
          severity: item.severity === 2 ? 'warning' : (item.severity ?? 1) > 2 ? 'info' : 'error',
          message: item.source ? `${item.source}: ${item.message}` : item.message,
        })));
        return true;
      },
    },
  });
}

export function displayEslint(view: EditorView, messages: LintMessage[]) {
  const doc = view.state.doc;
  const offset = (line: number, column: number) => {
    const row = doc.line(Math.max(1, Math.min(line, doc.lines)));
    return row.from + Math.max(0, Math.min(column - 1, row.length));
  };
  replaceDiagnostics(view, 'ESLint', messages.filter(item => item.line && item.column).map(item => {
    const from = offset(item.line!, item.column!);
    const end = item.endLine && item.endColumn ? offset(item.endLine, item.endColumn) : Math.min(from + 1, doc.length);
    return {
      from,
      to: Math.max(from, end),
      severity: item.severity === 2 ? 'error' : 'warning',
      message: item.ruleId ? `${item.message} (${item.ruleId})` : item.message,
    };
  }));
}

export function requestDefinition(
  view: EditorView, navigate: (definition: Definition) => Promise<void>,
  report: (message: string) => void, unavailable: string,
) {
    const plugin = LSPPlugin.get(view);
    if (!plugin?.client.serverCapabilities?.definitionProvider) {
      report(unavailable);
      return;
    }
    const { client, uri } = plugin;
    const doc = view.state.doc;
    const position = plugin.toPosition(view.state.selection.main.head);
    client.sync();
    void client.request<unknown, Location | (Location | LocationLink)[] | null>('textDocument/definition', { textDocument: { uri }, position })
      .then(async result => {
        if (!view.dom.isConnected || view.state.doc !== doc || LSPPlugin.get(view) !== plugin || !view.hasFocus) return;
        const target = Array.isArray(result) ? result[0] : result;
        if (!target) { report('No definition was found.'); return; }
        const location = 'targetUri' in target ? { uri: target.targetUri, range: target.targetSelectionRange } : target;
        await navigate({ uri: location.uri, ...location.range.start });
      })
      .catch(error => report(`Could not go to definition: ${error.message ?? String(error)}`));
}
