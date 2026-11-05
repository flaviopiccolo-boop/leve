use super::*;
use serde_json::{json, Value};
use std::{fs, sync::mpsc};

#[test]
fn frames_unicode_messages_and_rejects_truncated_or_oversized_frames() {
    let mut frames = Vec::new();
    for message in [r#"{"text":"ação 😀"}"#, r#"{"id":1}"#] {
        write_message(&mut frames, message).unwrap();
    }
    let mut reader = frames.as_slice();
    assert_eq!(
        read_message(&mut reader).unwrap().unwrap(),
        r#"{"text":"ação 😀"}"#
    );
    assert_eq!(read_message(&mut reader).unwrap().unwrap(), r#"{"id":1}"#);
    assert_eq!(read_message(&mut reader).unwrap(), None);
    assert!(read_message(&mut &b"Content-Length: 5\r\n\r\n{}"[..]).is_err());
    assert!(read_message(&mut &b"Content-Length: 999999999\r\n\r\n"[..]).is_err());
}

struct TestClient {
    _process: ManagedChild,
    input: ChildStdin,
    messages: mpsc::Receiver<Value>,
    backlog: Vec<Value>,
    root_uri: String,
    python: Option<String>,
    next_id: u64,
}

impl TestClient {
    fn start(kind: ServerKind, root: &Path, python: Option<String>) -> Self {
        let mut command = Command::new(node().unwrap());
        command
            .arg(server_script(kind).unwrap())
            .arg("--stdio")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut process = ManagedChild::spawn(&mut command).unwrap();
        let input = process.child.stdin.take().unwrap();
        let stdout = process.child.stdout.take().unwrap();
        let (send, messages) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(message)) = read_message(&mut reader) {
                if send.send(serde_json::from_str(&message).unwrap()).is_err() {
                    break;
                }
            }
        });
        let mut client = Self {
            _process: process,
            input,
            messages,
            backlog: Vec::new(),
            root_uri: file_uri(root).unwrap(),
            python,
            next_id: 1,
        };
        let result = client.request("initialize", json!({
            "processId": null, "rootUri": client.root_uri,
            "capabilities": { "workspace": { "configuration": true, "workspaceFolders": true }, "textDocument": { "publishDiagnostics": { "versionSupport": true } } },
            "initializationOptions": if kind == ServerKind::TypeScript { json!({ "disableAutomaticTypingAcquisition": true, "tsserver": { "useSyntaxServer": "never" } }) } else { Value::Null }
        }));
        let definition = &result["capabilities"]["definitionProvider"];
        assert!(definition == true || definition.is_object(), "{result}");
        client.notify("initialized", json!({}));
        if let Some(python) = &client.python {
            client.notify(
                "workspace/didChangeConfiguration",
                json!({ "settings": { "python": { "pythonPath": python } } }),
            );
        }
        client
    }

    fn send(&mut self, message: Value) {
        write_message(&mut self.input, &message.to_string()).unwrap();
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let response =
            self.receive(|message| message["id"] == id && message.get("method").is_none());
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }

    fn receive(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
        if let Some(index) = self.backlog.iter().position(&predicate) {
            return self.backlog.remove(index);
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let message = self
                .messages
                .recv_timeout(remaining)
                .unwrap_or_else(|err| panic!("{err}; messages: {:?}", self.backlog));
            if predicate(&message) {
                return message;
            }
            if let (Some(id), Some(method)) = (message.get("id"), message["method"].as_str()) {
                let result = match method {
                    "workspace/configuration" => Value::Array(
                        message["params"]["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|item| match item["section"].as_str() {
                                Some("python") => json!({ "pythonPath": self.python }),
                                Some("python.analysis") => {
                                    json!({ "diagnosticMode": "openFilesOnly" })
                                }
                                _ => json!({}),
                            })
                            .collect(),
                    ),
                    "workspace/workspaceFolders" => {
                        json!([{ "uri": self.root_uri, "name": "Project" }])
                    }
                    _ => Value::Null,
                };
                self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
            } else {
                self.backlog.push(message);
            }
        }
    }

    fn verify_document(
        &mut self,
        file: &Path,
        language: &str,
        source: &str,
        symbol: &str,
        target: &Path,
    ) {
        fs::write(file, source).unwrap();
        let uri = file_uri(file).unwrap();
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": { "uri": uri, "languageId": language, "version": 1, "text": source }
            }),
        );
        let offset = source.rfind(symbol).unwrap();
        let line = source[..offset]
            .bytes()
            .filter(|&byte| byte == b'\n')
            .count();
        let column = source[..offset]
            .rsplit('\n')
            .next()
            .unwrap()
            .encode_utf16()
            .count();
        let params = |column| json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": column } });
        let completions = self.request("textDocument/completion", params(column + 2));
        let items = completions
            .as_array()
            .or_else(|| completions["items"].as_array())
            .unwrap_or_else(|| panic!("{completions}"));
        assert!(
            items.iter().any(|item| item["label"] == symbol),
            "{symbol} missing from completion"
        );
        let definition = self.request("textDocument/definition", params(column + 1));
        let expected = target.canonicalize().unwrap();
        let matches_file = |uri: &str, path: &Path| {
            local_path(uri)
                .and_then(|file| file.canonicalize().map_err(error))
                .is_ok_and(|file| file == path)
        };
        let found = definition
            .as_array()
            .and_then(|items| items.first())
            .unwrap_or(&definition);
        let target_uri = found["uri"]
            .as_str()
            .or_else(|| found["targetUri"].as_str())
            .unwrap_or("");
        assert!(
            matches_file(target_uri, &expected),
            "{definition} should point to {expected:?}"
        );
        let source_path = file.canonicalize().unwrap();
        let diagnostics = self.receive(|msg| {
            msg["method"] == "textDocument/publishDiagnostics"
                && msg["params"]["uri"]
                    .as_str()
                    .is_some_and(|uri| matches_file(uri, &source_path))
                && msg["params"]["diagnostics"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["severity"] == 1))
        });
        if language == "python" {
            let items = diagnostics["params"]["diagnostics"].as_array().unwrap();
            assert!(
                items
                    .iter()
                    .any(|item| item["code"] == "reportAssignmentType"),
                "{diagnostics}"
            );
            assert!(
                !items
                    .iter()
                    .any(|item| item["code"] == "reportMissingImports"),
                "{diagnostics}"
            );
        }
    }
}

#[test]
#[ignore = "requires Pyright, TypeScript Language Server, ESLint, and a Django virtual environment"]
fn installed_tools_complete_diagnose_and_resolve_project_code() {
    let tool_dir = PathBuf::from(
        env::var_os("LEVE_TEST_LANGUAGE_TOOLS").expect("Set LEVE_TEST_LANGUAGE_TOOLS"),
    );
    let python = project_python(&tool_dir).expect("Install Django in the tools .venv");
    let temp = tempfile::tempdir_in(&tool_dir).unwrap();
    let root = temp.path();
    let helper = root.join("helper.py");
    fs::write(&helper, "def greet() -> str:\n    return 'hello'\n").unwrap();
    let mut py = TestClient::start(ServerKind::Python, root, Some(python));
    py.verify_document(&root.join("view.py"), "python",
        "from django.http import HttpResponse\nfrom helper import greet\n\ndef view(request):\n    count: int = 'bad'\n    return HttpResponse(greet())\n",
        "greet", &helper);
    drop(py);

    fs::write(root.join("tsconfig.json"), r#"{"compilerOptions":{"allowJs":true,"checkJs":true,"strict":true,"module":"ESNext","moduleResolution":"Bundler"},"include":["*.ts","*.js"]}"#).unwrap();
    let helper = root.join("helper.ts");
    let helper_js = root.join("helper-js.js");
    fs::write(&helper, "export function greet() { return 'hello'; }\n").unwrap();
    fs::write(&helper_js, "export function greet() { return 'hello'; }\n").unwrap();
    let mut ts = TestClient::start(ServerKind::TypeScript, root, None);
    let ts_file = root.join("main.ts");
    let js_file = root.join("script.js");
    ts.verify_document(
        &ts_file,
        "typescript",
        "import { greet } from './helper.js';\nconst count: number = 'bad';\ngreet();\n",
        "greet",
        &helper,
    );
    ts.verify_document(&js_file, "javascript",
        "import { greet } from './helper-js.js';\n/** @type {number} */\nconst count = 'bad';\ngreet();\n", "greet", &helper_js);

    fs::write(root.join("eslint.config.mjs"), "import parser from '@typescript-eslint/parser';\nexport default [{ files: ['**/*.{js,ts}'], languageOptions: { parser }, rules: { 'no-debugger': 'error' } }];\n").unwrap();
    let cli = tool_dir.join("node_modules/eslint/bin/eslint.js");
    for (file, source) in [
        (&ts_file, "const value: number = 3;\ndebugger;\n"),
        (&js_file, "debugger;\n"),
    ] {
        let messages = run_eslint(&cli, root, file, source.into(), &AtomicU64::new(0), 0).unwrap();
        assert!(messages
            .iter()
            .any(|item| item.rule_id.as_deref() == Some("no-debugger")));
    }
}
