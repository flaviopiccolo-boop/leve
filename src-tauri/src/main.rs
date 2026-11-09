#![cfg_attr(all(target_os = "windows", not(test)), windows_subsystem = "windows")]

mod shells;
mod session;
mod files;
mod search;
mod language;
mod git;

use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
#[cfg(test)]
use portable_pty::CommandBuilder;
use serde::Serialize;
use std::{collections::HashMap, fs, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use tauri::{ipc::{Channel, Response}, Manager, State};

const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024;
const MAX_IMAGE_SIZE: u64 = 20 * 1024 * 1024;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Workspace {
    language: language::LanguageTools,
    search: search::SearchState,
    operations: Mutex<()>,
    root: Mutex<Option<PathBuf>>,
    terminals: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Serialize)]
struct FileEntry { name: String, path: String, directory: bool }

fn error(err: impl std::fmt::Display) -> String { err.to_string() }

fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative).canonicalize().map_err(error)?;
    if !candidate.starts_with(root) {
        return Err("The path is outside the project folder.".into());
    }
    Ok(candidate)
}

fn workspace_root(workspace: &Workspace) -> Result<PathBuf, String> {
    workspace.root.lock().map_err(error)?.clone().ok_or_else(|| "Open a folder first.".into())
}

#[cfg(test)]
fn terminal_working_directory(root: &Path) -> &Path {
    // Keep canonical paths internally; shells and batch files need DOS paths.
    dunce::simplified(root)
}

fn text_file(path: &Path) -> Result<String, String> {
    if !path.is_file() { return Err("The path is not a file.".into()); }
    // Limit allocation even if a file grows between metadata lookup and reading.
    let mut data = Vec::new();
    fs::File::open(path).map_err(error)?.take(MAX_FILE_SIZE + 1).read_to_end(&mut data).map_err(error)?;
    if data.len() as u64 > MAX_FILE_SIZE { return Err("This version opens text files up to 4 MB.".into()); }
    if data.contains(&0) { return Err("This binary file format is not supported.".into()); }
    String::from_utf8(data).map_err(|_| "This version supports UTF-8 files.".into())
}

#[tauri::command]
async fn set_workspace(path: String, state: State<'_, Workspace>) -> Result<String, String> {
    let _operation = state.operations.lock().map_err(error)?;
    let root = PathBuf::from(path).canonicalize().map_err(error)?;
    if !root.is_dir() { return Err("Select a folder.".into()); }
    state.search.cancel(None);
    state.language.clear()?;
    state.terminals.lock().map_err(error)?.clear();
    let label = dunce::simplified(&root).to_string_lossy().to_string();
    *state.root.lock().map_err(error)? = Some(root);
    Ok(label)
}

#[tauri::command]
async fn list_directory(path: String, state: State<'_, Workspace>) -> Result<Vec<FileEntry>, String> {
    let root = workspace_root(&state)?;
    let directory = resolve(&root, &path)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(directory).map_err(error)? {
        let item = item.map_err(error)?;
        // Do not traverse symbolic links outside (or back into) the workspace.
        let kind = item.file_type().map_err(error)?;
        if kind.is_symlink() { continue; }
        let item_path = item.path();
        let relative = item_path.strip_prefix(&root).map_err(error)?;
        entries.push(FileEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: relative.to_string_lossy().replace('\\', "/"),
            directory: kind.is_dir(),
        });
    }
    Ok(entries)
}

#[tauri::command]
async fn read_file(path: String, state: State<'_, Workspace>) -> Result<String, String> {
    text_file(&resolve(&workspace_root(&state)?, &path)?)
}

fn image_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(error)?;
    if !metadata.is_file() { return Err("The path is not a file.".into()); }
    if metadata.len() > MAX_IMAGE_SIZE { return Err("Image previews support files up to 20 MB.".into()); }
    let mut data = Vec::new();
    fs::File::open(path).map_err(error)?.take(MAX_IMAGE_SIZE + 1).read_to_end(&mut data).map_err(error)?;
    if data.len() as u64 > MAX_IMAGE_SIZE { return Err("Image previews support files up to 20 MB.".into()); }
    Ok(data)
}

#[tauri::command]
async fn read_image(path: String, expected_root: String, state: State<'_, Workspace>) -> Result<Response, String> {
    let root = files::current_root(&state, &expected_root)?;
    let path = files::checked_path(&root, &path)?;
    tauri::async_runtime::spawn_blocking(move || image_file(&path).map(Response::new)).await.map_err(error)?
}

fn save_checked(path: &Path, content: &str, expected: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_SIZE { return Err("The file exceeds the 4 MB limit for this version.".into()); }
    if text_file(path)? != expected {
        return Err("The file has changed on disk. Copy your changes and reopen it before saving.".into());
    }
    let parent = path.parent().ok_or("Invalid folder.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(error)?;
    temporary.write_all(content.as_bytes()).map_err(error)?;
    temporary.as_file().set_permissions(fs::metadata(path).map_err(error)?.permissions()).map_err(error)?;
    temporary.as_file().sync_all().map_err(error)?;
    // Recheck immediately before replacing, to catch changes made during the write.
    if text_file(path)? != expected { return Err("The file changed while saving. Try reopening it.".into()); }
    temporary.persist(path).map_err(error)?;
    Ok(())
}

#[tauri::command]
async fn write_file(path: String, content: String, expected: String, state: State<'_, Workspace>) -> Result<(), String> {
    let _operation = state.operations.lock().map_err(error)?;
    save_checked(&resolve(&workspace_root(&state)?, &path)?, &content, &expected)
}

#[tauri::command]
async fn terminal_start(id: String, shell_id: Option<String>, cols: u16, rows: u16, output: Channel<Vec<u8>>, state: State<'_, Workspace>) -> Result<(), String> {
    let root = state.root.lock().map_err(error)?.clone()
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or("Could not find the home folder.")?;
    let mut sessions = state.terminals.lock().map_err(error)?;
    if sessions.contains_key(&id) { return Err("This session is already open.".into()); }
    if sessions.len() >= 16 { return Err("The limit of 16 terminals has been reached.".into()); }
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(error)?;
    let command = shells::command(shell_id.as_deref().unwrap_or("powershell"), &root)?;
    let mut reader = pair.master.try_clone_reader().map_err(error)?;
    let writer = pair.master.take_writer().map_err(error)?;
    let child = pair.slave.spawn_command(command).map_err(error)?;
    drop(pair.slave);
    sessions.insert(id, TerminalSession { master: pair.master, writer, child });
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => if output.send(buffer[..count].to_vec()).is_err() { break; },
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn terminal_write(id: String, data: String, state: State<'_, Workspace>) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(error)?;
    let terminal = terminals.get_mut(&id).ok_or("Terminal closed.")?;
    terminal.writer.write_all(data.as_bytes()).map_err(error)?;
    terminal.writer.flush().map_err(error)
}

#[tauri::command]
async fn terminal_resize(id: String, cols: u16, rows: u16, state: State<'_, Workspace>) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(error)?;
    let terminal = terminals.get_mut(&id).ok_or("Terminal closed.")?;
    terminal.master.resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(error)
}

#[tauri::command]
async fn terminal_close(id: String, state: State<'_, Workspace>) -> Result<(), String> {
    state.terminals.lock().map_err(error)?.remove(&id);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Workspace::default())
        .manage(session::SessionStore::default())
        .invoke_handler(tauri::generate_handler![set_workspace, list_directory, read_file, read_image, write_file, files::save_file_as, files::create_entry, files::rename_entry, files::delete_entry, search::search_content, search::cancel_search, git::git_status, git::git_diff, git::git_update_index, git::git_create_commit, git::git_remote_status, git::git_push, git::git_receive, git::git_branches, git::git_switch, git::git_history, git::git_commit_files, git::git_commit_diff, shells::list_shells, terminal_start, terminal_write, terminal_resize, terminal_close, session::session_load, session::session_save, language::lsp_start, language::lsp_send, language::lsp_stop, language::lsp_document, language::lsp_resolve, language::eslint_check])
        .build(tauri::generate_context!())
        .expect("Could not start Leve")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = app.state::<Workspace>().language.clear();
                if let Ok(mut sessions) = app.state::<Workspace>().terminals.lock() { sessions.clear(); }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_workspace() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(base.path().join("outside.txt"), "private").unwrap();
        let root = root.canonicalize().unwrap();
        assert!(resolve(&root, "../outside.txt").is_err());
    }

    #[test]
    fn reads_binary_image_bytes_and_rejects_files_over_the_preview_limit() {
        let base = tempfile::tempdir().unwrap();
        let path = base.path().join("image.png");
        let bytes = include_bytes!("../icons/256x256.png");
        fs::write(&path, bytes).unwrap();
        assert_eq!(image_file(&path).unwrap().as_slice(), bytes);
        fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(MAX_IMAGE_SIZE + 1).unwrap();
        assert!(image_file(&path).unwrap_err().contains("20 MB"));
    }

    #[test]
    fn preserves_external_changes_and_saves_matching_content() {
        let base = tempfile::tempdir().unwrap();
        let path = base.path().join("main.py");
        fs::write(&path, "external change").unwrap();
        assert!(save_checked(&path, "my edit", "old content").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external change");
        save_checked(&path, "my edit", "external change").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "my edit");
    }

    #[cfg(windows)]
    fn run_powershell(cwd: Option<&Path>, script: &str, marker: &str) -> String {
        let mut command = CommandBuilder::new("powershell.exe");
        let script = format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); {script}");
        command.args(["-NoLogo", "-NoProfile", "-Command", &script]);
        if let Some(cwd) = cwd { command.cwd(terminal_working_directory(cwd)); }
        run_pty(command, &[], marker)
    }

    #[cfg(windows)]
    fn run_pty(command: CommandBuilder, input: &[u8], marker: &str) -> String {
        let pair = native_pty_system().openpty(PtySize {
            rows: 24, cols: 80, pixel_width: 0, pixel_height: 0,
        }).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        writer.write_all(input).unwrap();
        writer.flush().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 { break; }
                if send.send(buffer[..count].to_vec()).is_err() { break; }
            }
        });
        let mut output = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
            let Ok(chunk) = receive.recv_timeout(remaining) else { break; };
            output.extend_from_slice(&chunk);
            // xterm.js answers this terminal cursor-position query in the app.
            if output.windows(4).any(|bytes| bytes == b"\x1b[6n") {
                let _ = writer.write_all(b"\x1b[1;1R");
                let _ = writer.flush();
            }
            if String::from_utf8_lossy(&output).contains(marker) { break; }
        }
        let _ = child.kill();
        let _ = child.wait();
        drop(pair.master);
        let output = String::from_utf8_lossy(&output).into_owned();
        assert!(output.contains(marker), "Received output: {output:?}");
        output
    }

    #[cfg(windows)]
    #[test]
    fn powershell_outputs_unicode_through_a_real_pty() {
        run_powershell(None, "[Console]::WriteLine('LEVE_PTY_OK_ação'); exit 0", "LEVE_PTY_OK_ação");
    }

    #[cfg(windows)]
    #[test]
    fn batch_files_keep_the_workspace_directory() {
        let base = tempfile::tempdir().unwrap();
        let project = base.path().join("project with spaces ação");
        fs::create_dir(&project).unwrap();
        fs::write(project.join("relative.txt"), "LEVE_RELATIVE_FILE_OK\r\n").unwrap();
        fs::write(project.join("check.cmd"), "@echo off\r\necho LEVE_CWD=%CD%\r\ntype relative.txt\r\n").unwrap();
        let canonical = project.canonicalize().unwrap();
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        let output = run_powershell(Some(&canonical), "& '.\\check.cmd'; exit $LASTEXITCODE", "LEVE_RELATIVE_FILE_OK");
        let expected_directory = format!("LEVE_CWD={}", terminal_working_directory(&canonical).display());
        assert!(output.contains(&expected_directory), "Received output: {output:?}");
        assert!(!output.contains("UNC paths are not supported"));
        assert!(!output.contains("Microsoft.PowerShell.Core\\FileSystem::"));
    }

    #[cfg(windows)]
    #[test]
    fn installed_shells_read_unicode_files_from_the_project_directory() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("shell project ação");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("relative.txt"), "LEVE_SHELL_FILE_OK_ação\r\n").unwrap();
        let canonical = root.canonicalize().unwrap();
        let mut tested = Vec::new();
        for profile in shells::list_shells().into_iter().filter(|profile| profile.available) {
            let (input, expected) = match profile.id {
                "cmd" => ("echo LEVE_CWD=%CD% & type relative.txt\r".to_string(), format!("LEVE_CWD={}", terminal_working_directory(&canonical).display())),
                "git-bash" => ("printf 'LEVE_CWD='; pwd -W; cat relative.txt\r".to_string(), format!("LEVE_CWD={}", terminal_working_directory(&canonical).display()).replace('\\', "/")),
                _ => ("[Console]::WriteLine('LEVE_CWD=' + (Get-Location).Path); Get-Content -Encoding UTF8 relative.txt\r".to_string(), format!("LEVE_CWD={}", terminal_working_directory(&canonical).display())),
            };
            let output = run_pty(shells::command(profile.id, &canonical).unwrap(), input.as_bytes(), "LEVE_SHELL_FILE_OK_ação");
            assert!(output.contains(&expected), "{} directory mismatch: {output:?}", profile.name);
            tested.push(profile.name);
        }
        assert!(tested.contains(&"PowerShell"));
        assert!(tested.contains(&"CMD"));
        println!("Verified shells: {}", tested.join(", "));
    }
}
