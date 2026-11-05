use std::{
    fs,
    io::Read,
    path::{Component, Path},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{error, files, Workspace};

const STATUS_LIMIT: usize = 1024 * 1024;
const DIFF_LIMIT: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChangeKind {
    Staged,
    Working,
    Untracked,
}

#[derive(Serialize)]
pub(crate) struct Change {
    path: String,
    status: char,
    kind: ChangeKind,
}

struct GitOutput {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

impl GitOutput {
    fn failure(&self) -> String {
        if self.stderr.trim().is_empty() {
            "Git could not complete the request.".into()
        } else {
            self.stderr.trim().to_owned()
        }
    }
}

fn run(root: &Path, args: &[&str], limit: usize, limit_message: &str) -> Result<GitOutput, String> {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let executable = crate::shells::git_executable()
            .ok_or("Install Git for Windows to view project changes.")?;
        let mut command = Command::new(executable);
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(not(windows))]
    let mut command = Command::new("git");

    let mut child = command
        .current_dir(dunce::simplified(root))
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR")
        .args([
            "--no-pager",
            "--no-optional-locks",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotePath=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                "Install Git to view project changes.".into()
            } else {
                error(err)
            }
        })?;
    let mut stderr = child.stderr.take().expect("Git stderr is piped");
    let diagnostic = std::thread::spawn(move || {
        let mut message = Vec::new();
        let _ = (&mut stderr).take(8192).read_to_end(&mut message);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        String::from_utf8_lossy(&message).into_owned()
    });
    let mut stdout = Vec::new();
    let read = child
        .stdout
        .take()
        .expect("Git stdout is piped")
        .take(limit as u64 + 1)
        .read_to_end(&mut stdout);
    if read.is_err() || stdout.len() > limit {
        let _ = child.kill();
    }
    let status = child.wait();
    let stderr = diagnostic.join().unwrap_or_default();
    read.map_err(error)?;
    if stdout.len() > limit {
        return Err(limit_message.into());
    }
    Ok(GitOutput {
        code: status.map_err(error)?.code(),
        stdout,
        stderr,
    })
}

fn repository_changes(root: &Path, require_root: bool) -> Result<Option<Vec<Change>>, String> {
    let repository = run(
        root,
        &["rev-parse", "--is-inside-work-tree", "--show-prefix"],
        STATUS_LIMIT,
        "Git repository path is too long.",
    )?;
    if repository.code != Some(0) {
        if repository.stderr.starts_with("fatal: not a git repository") {
            return Ok(None);
        }
        return Err(repository.failure());
    }
    let repository = String::from_utf8(repository.stdout).map_err(error)?;
    let Some(prefix) = repository.strip_prefix("true\n") else {
        return Ok(None);
    };
    let prefix = prefix.strip_suffix('\n').unwrap_or(prefix);
    if require_root && !prefix.is_empty() {
        return Ok(None);
    }
    let status = run(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
            "--",
            ".",
        ],
        STATUS_LIMIT,
        "The Git change list exceeds 1 MiB. Open a smaller folder to inspect its changes.",
    )?;
    if status.code != Some(0) {
        return Err(status.failure());
    }
    parse_changes(&status.stdout, prefix).map(Some)
}

fn is_nested_repository(folder: &Path) -> bool {
    fs::symlink_metadata(folder)
        .is_ok_and(|metadata| metadata.is_dir() && !files::linked(&metadata))
        && fs::symlink_metadata(folder.join(".git")).is_ok_and(|metadata| {
            !files::linked(&metadata) && (metadata.is_dir() || metadata.is_file())
        })
}

fn changes(root: &Path) -> Result<Option<Vec<Change>>, String> {
    let mut result = repository_changes(root, false)?;
    // Inspect direct children only, as with VS Code's default scan depth.
    for entry in fs::read_dir(root).map_err(error)?.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if matches!(name, ".git" | "node_modules") || !is_nested_repository(&entry.path()) {
            continue;
        }
        let Some(nested) = repository_changes(&entry.path(), true)? else {
            continue;
        };
        let prefix = format!("{name}/");
        let changes = result.get_or_insert_with(Vec::new);
        // Git can report an embedded repository as a single untracked directory.
        changes.retain(|change| !change.path.starts_with(&prefix));
        changes.extend(nested.into_iter().map(|mut change| {
            change.path.insert_str(0, &prefix);
            change
        }));
    }
    Ok(result)
}

fn parse_changes(output: &[u8], prefix: &str) -> Result<Vec<Change>, String> {
    let output = std::str::from_utf8(output).map_err(error)?;
    let mut changes = Vec::new();
    for entry in output.split_terminator('\0') {
        let [index, worktree, b' ', ..] = entry.as_bytes() else {
            return Err("Invalid Git status output.".into());
        };
        let Some(path) = entry[3..].strip_prefix(prefix) else {
            continue;
        };
        match &entry.as_bytes()[..2] {
            b"??" => changes.push(Change {
                path: path.into(),
                status: '?',
                kind: ChangeKind::Untracked,
            }),
            b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU" => {
                changes.push(Change {
                    path: path.into(),
                    status: 'U',
                    kind: ChangeKind::Working,
                });
            }
            _ => {
                for (status, kind) in [
                    (*index, ChangeKind::Staged),
                    (*worktree, ChangeKind::Working),
                ] {
                    if status != b' ' {
                        changes.push(Change {
                            path: path.into(),
                            status: status.into(),
                            kind,
                        });
                    }
                }
            }
        }
    }
    Ok(changes)
}

fn diff(root: &Path, path: &str, kind: ChangeKind) -> Result<String, String> {
    if path.is_empty() || path.contains('\\') || Path::new(path).components().any(|component| {
        !matches!(component, Component::Normal(name) if !name.eq_ignore_ascii_case(".git"))
    }) {
        return Err("Select a file inside the project folder.".into());
    }

    let nested;
    let (root, path) = match path.split_once('/') {
        Some((folder, relative))
            if folder != "node_modules" && is_nested_repository(&root.join(folder)) =>
        {
            nested = root.join(folder);
            (nested.as_path(), relative)
        }
        _ => (root, path),
    };

    let mut args = vec![
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
    ];
    let untracked_path;
    if kind == ChangeKind::Untracked {
        let target = files::checked_path(root, path)?;
        if !target.is_file() || target.metadata().map_err(error)?.len() > crate::MAX_FILE_SIZE {
            return Err("New-file diffs support regular files up to 4 MB.".into());
        }
        untracked_path = format!("./{path}");
        args.extend([
            "--no-index",
            "--no-relative",
            "--",
            "/dev/null",
            &untracked_path,
        ]);
    } else {
        args.extend([
            "--relative",
            "--ignore-submodules=dirty",
            "--submodule=short",
        ]);
        if kind == ChangeKind::Staged {
            args.push("--cached");
        }
        args.extend(["--", path]);
    }
    let patch = run(
        root,
        &args,
        DIFF_LIMIT,
        "The diff exceeds 256 KiB. Open the file to inspect it.",
    )?;
    if patch.code != Some(0) && !(kind == ChangeKind::Untracked && patch.code == Some(1)) {
        return Err(patch.failure());
    }
    Ok(String::from_utf8_lossy(&patch.stdout).into_owned())
}

#[tauri::command]
pub(crate) async fn git_status(
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<Option<Vec<Change>>, String> {
    let root = files::current_root(&state, &expected_root)?;
    tauri::async_runtime::spawn_blocking(move || changes(&root))
        .await
        .map_err(error)?
}

#[tauri::command]
pub(crate) async fn git_diff(
    path: String,
    kind: ChangeKind,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<String, String> {
    let root = files::current_root(&state, &expected_root)?;
    tauri::async_runtime::spawn_blocking(move || diff(&root, &path, kind))
        .await
        .map_err(error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(root: &Path, args: &[&str]) {
        let output = run(root, args, STATUS_LIMIT, "Unexpected test output").unwrap();
        assert_eq!(output.code, Some(0), "{}", output.failure());
    }

    #[test]
    fn finds_an_initialized_child_repository_from_its_parent_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let app = root.join("app");
        fs::create_dir(&app).unwrap();
        fs::write(app.join("main.txt"), "inside app\n").unwrap();
        assert!(changes(&root).unwrap().is_none());

        git(&app, &["init", "-q"]);
        let untracked = changes(&root).unwrap().unwrap();
        assert_eq!(untracked.len(), 1);
        assert_eq!(untracked[0].path, "app/main.txt");
        assert_eq!(untracked[0].kind, ChangeKind::Untracked);
        assert!(diff(&root, "app/main.txt", ChangeKind::Untracked)
            .unwrap()
            .contains("+inside app"));

        git(&root, &["init", "-q"]);
        git(&app, &["add", "main.txt"]);
        fs::write(root.join("outside.txt"), "outside app\n").unwrap();
        let combined = changes(&root).unwrap().unwrap();
        assert_eq!(combined.len(), 2);
        assert!(combined.iter().any(|change| change.path == "outside.txt"));
        assert!(combined
            .iter()
            .any(|change| change.path == "app/main.txt" && change.kind == ChangeKind::Staged));
        assert!(diff(&root, "app/main.txt", ChangeKind::Staged)
            .unwrap()
            .contains("+inside app"));
    }

    #[test]
    fn shows_index_worktree_and_new_files_within_the_open_folder() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        assert!(changes(&root).unwrap().is_none());
        git(&root, &["init", "-q"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        assert!(changes(&root).unwrap().unwrap().is_empty());
        let folder = root.join("sub folder");
        fs::create_dir(&folder).unwrap();
        let name = "ação [1].txt";
        let file = folder.join(name);
        fs::write(&file, "original\n").unwrap();
        fs::write(folder.join("deleted.txt"), "deleted\n").unwrap();
        git(&folder, &["add", "."]);
        let initial = diff(&folder, name, ChangeKind::Staged).unwrap();
        assert!(initial.contains("+original"));
        git(
            &root,
            &[
                "-c",
                "user.name=Leve test",
                "-c",
                "user.email=leve@example.test",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "-qm",
                "Initial files",
            ],
        );
        fs::write(&file, "staged\n").unwrap();
        git(&folder, &["add", "--", name]);
        fs::write(&file, "working\n").unwrap();
        fs::remove_file(folder.join("deleted.txt")).unwrap();
        fs::write(folder.join("-"), "untracked\n").unwrap();
        fs::write(root.join("outside.txt"), "outside\n").unwrap();

        let list = changes(&folder).unwrap().unwrap();
        let entries: Vec<_> = list
            .iter()
            .map(|entry| (entry.path.as_str(), entry.kind, entry.status))
            .collect();
        assert_eq!(
            entries,
            [
                (name, ChangeKind::Staged, 'M'),
                (name, ChangeKind::Working, 'M'),
                ("deleted.txt", ChangeKind::Working, 'D'),
                ("-", ChangeKind::Untracked, '?'),
            ]
        );
        let staged = diff(&folder, name, ChangeKind::Staged).unwrap();
        assert!(staged.contains("-original") && staged.contains("+staged"));
        let working = diff(&folder, name, ChangeKind::Working).unwrap();
        assert!(working.contains("-staged") && working.contains("+working"));
        assert!(diff(&folder, "deleted.txt", ChangeKind::Working)
            .unwrap()
            .contains("-deleted"));
        assert!(diff(&folder, "-", ChangeKind::Untracked)
            .unwrap()
            .contains("+untracked"));
        assert!(diff(&folder, "../outside.txt", ChangeKind::Untracked).is_err());
    }
}
