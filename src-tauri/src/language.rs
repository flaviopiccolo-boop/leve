use crate::{error, resolve, workspace_root, Workspace, MAX_FILE_SIZE};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};
use url::Url;

const MAX_MESSAGE: usize = 32 * 1024 * 1024;
const MAX_HEADER: usize = 8192;
const MAX_LINT_OUTPUT: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServerKind {
    Python,
    TypeScript,
}

impl ServerKind {
    fn script(self) -> &'static str {
        match self {
            Self::Python => "pyright/langserver.index.js",
            Self::TypeScript => "typescript-language-server/lib/cli.mjs",
        }
    }

    fn install_hint(self) -> &'static str {
        match self {
            Self::Python => "Pyright was not found. Run npm install -g pyright and restart Leve.",
            Self::TypeScript => "TypeScript Language Server was not found. Run npm install -g typescript typescript-language-server and restart Leve.",
        }
    }
}

#[derive(Default)]
pub struct LanguageTools {
    servers: Mutex<HashMap<ServerKind, Server>>,
    generation: Arc<AtomicU64>,
    lint_jobs: Arc<AtomicUsize>,
}

impl LanguageTools {
    pub fn clear(&self) -> Result<(), String> {
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.servers.lock().map_err(error)?.clear();
        Ok(())
    }
}

struct Server {
    id: String,
    input: Arc<Mutex<ChildStdin>>,
    _process: ManagedChild,
}

struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}

impl ManagedChild {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut process = Self {
            child: command.spawn()?,
            #[cfg(windows)]
            job: None,
        };
        #[cfg(windows)]
        {
            process.job = Some(process_job(&process.child)?);
        }
        Ok(process)
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        #[cfg(windows)]
        drop(self.job.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
fn process_job(child: &Child) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::{
        mem::size_of_val,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr::null,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // The TypeScript server spawns tsserver. Closing the job also stops its descendants.
    unsafe {
        let handle = CreateJobObjectW(null(), null());
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = OwnedHandle::from_raw_handle(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
}

fn path_dirs() -> impl Iterator<Item = PathBuf> {
    env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .filter(|path| path.is_absolute())
        .collect::<Vec<_>>()
        .into_iter()
}

fn node() -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    path_dirs()
        .map(|path| path.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| "Node.js was not found on PATH. Install Node.js and restart Leve.".into())
}

fn server_script(kind: ServerKind) -> Result<PathBuf, String> {
    let mut folders: Vec<PathBuf> = path_dirs()
        .flat_map(|path| {
            let parent = path.parent().unwrap_or(&path);
            [
                path.join("node_modules"),
                parent.join("lib/node_modules"),
                parent.to_path_buf(),
            ]
        })
        .collect();
    if let Some(prefix) = env::var_os("APPDATA") {
        folders.push(PathBuf::from(prefix).join("npm/node_modules"));
    }
    folders
        .into_iter()
        .map(|path| path.join(kind.script()))
        .find(|path| path.is_file())
        .ok_or_else(|| kind.install_hint().into())
}

fn check_root(workspace: &Workspace, expected: &str) -> Result<PathBuf, String> {
    let root = workspace_root(workspace)?;
    if dunce::simplified(&root).to_string_lossy() != expected {
        return Err("The project changed.".into());
    }
    Ok(root)
}

fn file_uri(path: &Path) -> Result<String, String> {
    Url::from_file_path(dunce::simplified(path))
        .map(String::from)
        .map_err(|_| "Could not create a file URI.".into())
}

fn local_path(uri: &str) -> Result<PathBuf, String> {
    let uri = Url::parse(uri).map_err(error)?;
    if uri.scheme() != "file" {
        return Err("The definition is not a local file.".into());
    }
    uri.to_file_path()
        .map_err(|_| "The definition is not a local file.".into())
}

fn read_message(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut length = None;
    let mut header_bytes = 0;
    loop {
        let mut line = String::new();
        let count = reader
            .take((MAX_HEADER + 1 - header_bytes) as u64)
            .read_line(&mut line)?;
        if count == 0 && header_bytes == 0 {
            return Ok(None);
        }
        header_bytes += count;
        if count == 0 || header_bytes > MAX_HEADER {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Incomplete or oversized LSP header",
            ));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("Content-Length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let length = length
        .filter(|length| (1..=MAX_MESSAGE).contains(length))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Invalid LSP content length"))?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn write_message(input: &mut impl Write, message: &str) -> io::Result<()> {
    write!(input, "Content-Length: {}\r\n\r\n", message.len())?;
    input.write_all(message.as_bytes())?;
    input.flush()
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ServerEvent {
    Message { message: String },
    Closed { error: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    root_uri: String,
    python_path: Option<String>,
}

fn project_python(root: &Path) -> Option<String> {
    let executable = if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    };
    [".venv", "venv"]
        .into_iter()
        .map(|dir| root.join(dir).join(executable))
        .find(|path| path.is_file())
        .map(|path| dunce::simplified(&path).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn lsp_start(
    kind: ServerKind,
    id: String,
    expected_root: String,
    output: Channel<ServerEvent>,
    state: State<'_, Workspace>,
) -> Result<ServerInfo, String> {
    let _operation = state.operations.lock().map_err(error)?;
    let root = check_root(&state, &expected_root)?;
    let root_uri = file_uri(&root)?;
    let mut servers = state.language.servers.lock().map_err(error)?;
    servers.remove(&kind);
    let mut command = Command::new(node()?);
    command
        .arg(server_script(kind)?)
        .arg("--stdio")
        .current_dir(dunce::simplified(&root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut process = ManagedChild::spawn(&mut command).map_err(error)?;
    let input = process
        .child
        .stdin
        .take()
        .ok_or("No language server input.")?;
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or("No language server output.")?;
    servers.insert(
        kind,
        Server {
            id,
            input: Arc::new(Mutex::new(input)),
            _process: process,
        },
    );
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_message(&mut reader) {
                Ok(Some(message)) => {
                    if output.send(ServerEvent::Message { message }).is_err() {
                        break;
                    }
                }
                result => {
                    let error = result
                        .err()
                        .map(|err| err.to_string())
                        .unwrap_or_else(|| "The language server exited.".into());
                    let _ = output.send(ServerEvent::Closed { error });
                    break;
                }
            }
        }
    });
    Ok(ServerInfo {
        root_uri,
        python_path: project_python(&root).filter(|_| kind == ServerKind::Python),
    })
}

#[tauri::command]
pub async fn lsp_send(
    kind: ServerKind,
    id: String,
    message: String,
    state: State<'_, Workspace>,
) -> Result<(), String> {
    if message.len() > MAX_MESSAGE {
        return Err("The language server message exceeds the size limit.".into());
    }
    let input = state
        .language
        .servers
        .lock()
        .map_err(error)?
        .get(&kind)
        .filter(|server| server.id == id)
        .map(|server| Arc::clone(&server.input))
        .ok_or("Language server stopped.")?;
    tauri::async_runtime::spawn_blocking(move || {
        write_message(&mut *input.lock().map_err(error)?, &message).map_err(error)
    })
    .await
    .map_err(error)?
}

#[tauri::command]
pub async fn lsp_stop(
    kind: ServerKind,
    id: String,
    state: State<'_, Workspace>,
) -> Result<(), String> {
    let mut servers = state.language.servers.lock().map_err(error)?;
    if servers.get(&kind).is_some_and(|server| server.id == id) {
        servers.remove(&kind);
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_document(
    path: String,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<String, String> {
    let root = check_root(&state, &expected_root)?;
    file_uri(&resolve(&root, &path)?)
}

#[tauri::command]
pub async fn lsp_resolve(
    uri: String,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<String, String> {
    let root = check_root(&state, &expected_root)?;
    let path = local_path(&uri)?;
    let path = resolve(&root, &path.to_string_lossy())?;
    if !path.is_file() {
        return Err("The definition is not a file.".into());
    }
    Ok(path
        .strip_prefix(&root)
        .map_err(error)?
        .to_string_lossy()
        .replace('\\', "/"))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintMessage {
    line: Option<usize>,
    column: Option<usize>,
    end_line: Option<usize>,
    end_column: Option<usize>,
    severity: u8,
    message: String,
    rule_id: Option<String>,
}

#[derive(Deserialize)]
struct LintResult {
    messages: Vec<LintMessage>,
}

fn eslint_paths(root: &Path, file: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut cwd = None;
    let mut cli = None;
    for parent in file
        .parent()?
        .ancestors()
        .take_while(|parent| parent.starts_with(root))
    {
        if cwd.is_none()
            && [
                "eslint.config.js",
                "eslint.config.mjs",
                "eslint.config.cjs",
                "eslint.config.ts",
                "eslint.config.mts",
                "eslint.config.cts",
                ".eslintrc",
                ".eslintrc.js",
                ".eslintrc.cjs",
                ".eslintrc.json",
                ".eslintrc.yaml",
                ".eslintrc.yml",
            ]
            .iter()
            .any(|name| parent.join(name).is_file())
        {
            cwd = Some(parent.to_path_buf());
        }
        let candidate = parent.join("node_modules/eslint/bin/eslint.js");
        if cli.is_none() && candidate.is_file() {
            cli = Some(candidate);
        }
    }
    cli.map(|cli| (cli, cwd.unwrap_or_else(|| root.to_path_buf())))
}

fn collect_output(stream: impl Read + Send + 'static) -> thread::JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        stream.take(MAX_LINT_OUTPUT + 1).read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}

fn run_eslint(
    cli: &Path,
    cwd: &Path,
    file: &Path,
    content: String,
    generation: &AtomicU64,
    expected_generation: u64,
) -> Result<Vec<LintMessage>, String> {
    let mut command = Command::new(node()?);
    command
        .arg(dunce::simplified(cli))
        .args(["--stdin", "--stdin-filename"])
        .arg(dunce::simplified(file))
        .args(["--format", "json"])
        .current_dir(dunce::simplified(cwd))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = ManagedChild::spawn(&mut command).map_err(error)?;
    let mut stdin = process.child.stdin.take().ok_or("No ESLint input.")?;
    let input = thread::spawn(move || stdin.write_all(content.as_bytes()));
    let output = collect_output(process.child.stdout.take().ok_or("No ESLint output.")?);
    let errors = collect_output(
        process
            .child
            .stderr
            .take()
            .ok_or("No ESLint error stream.")?,
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = process.child.try_wait().map_err(error)? {
            break status;
        }
        if generation.load(Ordering::Relaxed) != expected_generation {
            return Err("The project changed.".into());
        }
        if Instant::now() >= deadline {
            return Err("ESLint timed out.".into());
        }
        thread::sleep(Duration::from_millis(25));
    };
    drop(process);
    let output = output
        .join()
        .map_err(|_| "Could not collect ESLint output.")?
        .map_err(error)?;
    let errors = errors
        .join()
        .map_err(|_| "Could not collect ESLint errors.")?
        .map_err(error)?;
    if !matches!(status.code(), Some(0 | 1)) {
        let detail: String = String::from_utf8_lossy(&errors)
            .trim()
            .chars()
            .take(600)
            .collect();
        return Err(format!("ESLint failed: {detail}"));
    }
    input
        .join()
        .map_err(|_| "Could not send the file to ESLint.")?
        .map_err(error)?;
    if output.len() as u64 > MAX_LINT_OUTPUT {
        return Err("ESLint output exceeds the size limit.".into());
    }
    let results: Vec<LintResult> = serde_json::from_slice(&output).map_err(error)?;
    Ok(results
        .into_iter()
        .flat_map(|result| result.messages)
        .take(500)
        .collect())
}

struct LintSlot(Arc<AtomicUsize>);

impl Drop for LintSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn eslint_check(
    path: String,
    content: String,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<Vec<LintMessage>, String> {
    if content.len() as u64 > MAX_FILE_SIZE {
        return Err("This file is too large for ESLint validation.".into());
    }
    let (root, generation, expected_generation) = {
        let _operation = state.operations.lock().map_err(error)?;
        let root = check_root(&state, &expected_root)?;
        let generation = Arc::clone(&state.language.generation);
        let expected_generation = generation.load(Ordering::Relaxed);
        (root, generation, expected_generation)
    };
    let file = resolve(&root, &path)?;
    let Some((cli, cwd)) = eslint_paths(&root, &file) else {
        return Err("ESLint is not installed in this project. Install the project's npm dependencies, then reopen the file.".into());
    };
    state
        .language
        .lint_jobs
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |jobs| {
            (jobs < 4).then_some(jobs + 1)
        })
        .map_err(|_| "ESLint is busy. Wait a moment and edit the file again.")?;
    let slot = LintSlot(Arc::clone(&state.language.lint_jobs));
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        run_eslint(&cli, &cwd, &file, content, &generation, expected_generation)
    })
    .await
    .map_err(error)?
}

#[cfg(test)]
mod tests;
