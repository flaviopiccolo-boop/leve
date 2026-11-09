use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Component, Path},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{error, files, Workspace};

const STATUS_LIMIT: usize = 1024 * 1024;
const DIFF_LIMIT: usize = 256 * 1024;
const HISTORY_PAGE: usize = 30;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Repository {
    id: String,
    branch: Option<String>,
    head: Option<String>,
    can_switch: bool,
    changes: Vec<Change>,
}

#[derive(Serialize)]
pub(crate) struct Commit {
    id: String,
    subject: String,
    author: String,
    date: i64,
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
    run_with_input(root, args, None, limit, limit_message)
}

fn run_with_input(
    root: &Path,
    args: &[&str],
    input: Option<Vec<u8>>,
    limit: usize,
    limit_message: &str,
) -> Result<GitOutput, String> {
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
        .env("GIT_TERMINAL_PROMPT", "0")
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
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
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
    let writer = input.map(|input| {
        let mut stdin = child.stdin.take().expect("Git stdin is piped");
        std::thread::spawn(move || stdin.write_all(&input))
    });
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
    let written = writer.map(|writer| writer.join().expect("Git stdin writer finished"));
    read.map_err(error)?;
    if stdout.len() > limit {
        return Err(limit_message.into());
    }
    let code = status.map_err(error)?.code();
    if code == Some(0) {
        if let Some(written) = written {
            written.map_err(error)?;
        }
    }
    Ok(GitOutput {
        code,
        stdout,
        stderr,
    })
}

fn repository_prefix(root: &Path) -> Result<Option<String>, String> {
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
    Ok(Some(prefix.strip_suffix('\n').unwrap_or(prefix).into()))
}

fn repository_status(root: &Path, id: &str) -> Result<Option<Repository>, String> {
    let Some(prefix) = repository_prefix(root)? else {
        return Ok(None);
    };
    if !id.is_empty() && !prefix.is_empty() {
        return Ok(None);
    }
    let changes = repository_changes(root, &prefix)?;
    let branch = run(
        root,
        &["symbolic-ref", "--quiet", "HEAD"],
        STATUS_LIMIT,
        "Branch name is too long.",
    )?;
    let branch = match branch.code {
        Some(0) => Some(
            String::from_utf8(branch.stdout)
                .map_err(error)?
                .trim_end()
                .strip_prefix("refs/heads/")
                .ok_or("Invalid Git branch reference.")?
                .to_owned(),
        ),
        Some(1) => None,
        _ => return Err(branch.failure()),
    };
    let head = run(
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        STATUS_LIMIT,
        "Git revision is too long.",
    )?;
    let head = match head.code {
        Some(0) => Some(
            String::from_utf8(head.stdout)
                .map_err(error)?
                .trim_end()
                .to_owned(),
        ),
        Some(1) => None,
        _ => return Err(head.failure()),
    };
    Ok(Some(Repository {
        id: id.into(),
        branch,
        head,
        can_switch: prefix.is_empty(),
        changes,
    }))
}

fn repository_changes(root: &Path, prefix: &str) -> Result<Vec<Change>, String> {
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
    parse_changes(&status.stdout, prefix)
}

fn is_nested_repository(folder: &Path) -> bool {
    fs::symlink_metadata(folder)
        .is_ok_and(|metadata| metadata.is_dir() && !files::linked(&metadata))
        && fs::symlink_metadata(folder.join(".git")).is_ok_and(|metadata| {
            !files::linked(&metadata) && (metadata.is_dir() || metadata.is_file())
        })
}

fn repositories(root: &Path) -> Result<Vec<Repository>, String> {
    let mut result: Vec<_> = repository_status(root, "")?.into_iter().collect();
    // Inspect direct children only, as with VS Code's default scan depth.
    for entry in fs::read_dir(root).map_err(error)?.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if matches!(name, ".git" | "node_modules") || !is_nested_repository(&entry.path()) {
            continue;
        }
        let Some(mut nested) = repository_status(&entry.path(), name)? else {
            continue;
        };
        let prefix = format!("{name}/");
        // Git can report an embedded repository as a single untracked directory.
        if let Some(parent) = result.first_mut().filter(|repo| repo.id.is_empty()) {
            parent
                .changes
                .retain(|change| !change.path.starts_with(&prefix));
        }
        for change in &mut nested.changes {
            change.path.insert_str(0, &prefix);
        }
        result.push(nested);
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

#[cfg(test)]
fn changes(root: &Path) -> Result<Option<Vec<Change>>, String> {
    let repositories = repositories(root)?;
    Ok((!repositories.is_empty()).then(|| {
        repositories
            .into_iter()
            .flat_map(|repo| repo.changes)
            .collect()
    }))
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
) -> Result<Vec<Repository>, String> {
    let root = files::current_root(&state, &expected_root)?;
    tauri::async_runtime::spawn_blocking(move || repositories(&root))
        .await
        .map_err(error)?
}

fn select_repository(
    root: &Path,
    repo: &str,
    require_root: bool,
) -> Result<std::path::PathBuf, String> {
    let target = if repo.is_empty() {
        root.to_path_buf()
    } else if !repo.contains(['/', '\\'])
        && repo != "node_modules"
        && repo != ".git"
        && matches!(
            Path::new(repo).components().next(),
            Some(Component::Normal(_))
        )
        && is_nested_repository(&root.join(repo))
    {
        files::checked_path(root, repo)?
    } else {
        return Err("The selected Git repository is no longer available.".into());
    };
    let prefix =
        repository_prefix(&target)?.ok_or("The selected Git repository is no longer available.")?;
    if !prefix.is_empty() && (require_root || !repo.is_empty()) {
        return Err("Open the repository root to switch branches.".into());
    }
    Ok(target)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IndexAction {
    Stage,
    Unstage,
}

fn update_index(
    root: &Path,
    repo: &str,
    action: IndexAction,
    paths: &[String],
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let target = select_repository(root, repo, false)?;
    let prefix =
        repository_prefix(&target)?.ok_or("The selected Git repository is no longer available.")?;
    let changes = repository_changes(&target, &prefix)?;
    let staged = matches!(action, IndexAction::Unstage);
    let candidates: HashSet<_> = changes
        .iter()
        .filter(|change| (change.kind == ChangeKind::Staged) == staged)
        .map(|change| change.path.as_str())
        .collect();
    let eligible: HashSet<_> = changes
        .iter()
        .filter(|change| {
            (change.kind == ChangeKind::Staged) == staged
                && change.status != 'U'
                && !change.path.ends_with('/')
        })
        .map(|change| change.path.as_str())
        .collect();
    let mut selected = HashSet::new();
    let mut input = Vec::new();
    for path in paths {
        let relative = if repo.is_empty() {
            Some(path.as_str())
        } else {
            path.strip_prefix(repo)
                .and_then(|path| path.strip_prefix('/'))
        };
        let relative = relative.filter(|path| eligible.contains(path)).ok_or(
            "The selected Git changes have changed. Review the refreshed list and try again.",
        )?;
        if repo.is_empty()
            && relative
                .split_once('/')
                .is_some_and(|(folder, _)| is_nested_repository(&target.join(folder)))
        {
            return Err("Select the nested repository to update its files.".into());
        }
        if selected.insert(relative) {
            input.extend_from_slice(relative.as_bytes());
            input.push(0);
        }
    }
    // A pathspec can also match descendants when a file was replaced by a directory.
    for path in &candidates {
        if path.match_indices('/').any(|(end, _)| {
            let parent = &path[..end];
            candidates.contains(parent) && selected.contains(parent) != selected.contains(path)
        }) {
            return Err("Select all related changes together when a file replaces a folder or a folder replaces a file.".into());
        }
    }
    let mut args = match action {
        IndexAction::Stage => vec!["add", "--all", "--no-ignore-errors"],
        IndexAction::Unstage => vec!["reset", "--quiet"],
    };
    args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    let output = run_with_input(
        &target,
        &args,
        Some(input),
        STATUS_LIMIT,
        "Git returned too much output while updating the index.",
    )?;
    if output.code != Some(0) {
        return Err(output.failure());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_update_index(
    repo: String,
    action: IndexAction,
    paths: Vec<String>,
    expected_root: String,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Workspace>();
        let _operation = state.operations.lock().map_err(error)?;
        let root = files::current_root(&state, &expected_root)?;
        update_index(&root, &repo, action, &paths)
    })
    .await
    .map_err(error)?
}

#[derive(Deserialize)]
pub(crate) struct CommitRequest {
    branch: String,
    head: Option<String>,
    paths: Vec<String>,
    message: String,
}

fn create_commit(root: &Path, repo: &str, request: CommitRequest) -> Result<(), String> {
    if request.message.trim().is_empty() {
        return Err("Enter a commit message.".into());
    }
    if request.message.len() > 64 * 1024 || request.message.contains('\0') {
        return Err("The commit message must be valid text up to 64 KiB.".into());
    }
    let target = select_repository(root, repo, false)?;
    let status = repository_status(&target, repo)?
        .ok_or("The selected Git repository is no longer available.")?;
    if !status.can_switch {
        return Err("Open the repository root to commit.".into());
    }
    if status.branch.as_deref() != Some(request.branch.as_str()) || status.head != request.head {
        return Err("The branch changed. Review the refreshed Git changes and try again.".into());
    }
    if status.changes.iter().any(|change| change.status == 'U') {
        return Err("Resolve all Git conflicts before committing.".into());
    }
    let staged: HashSet<_> = status
        .changes
        .iter()
        .filter(|change| change.kind == ChangeKind::Staged)
        .map(|change| change.path.as_str())
        .collect();
    if staged.is_empty() {
        return Err("Stage at least one change before committing.".into());
    }
    let expected: HashSet<_> = request
        .paths
        .iter()
        .filter_map(|path| {
            if repo.is_empty() {
                Some(path.as_str())
            } else {
                path.strip_prefix(repo)
                    .and_then(|path| path.strip_prefix('/'))
            }
        })
        .collect();
    if staged != expected || expected.len() != request.paths.len() {
        return Err("The staged files differ from the panel. Review the refreshed list or inspect the index in the terminal.".into());
    }
    let output = run_with_input(
        &target,
        &[
            "-c",
            "i18n.commitEncoding=UTF-8",
            "commit",
            "--quiet",
            "--file=-",
            "--cleanup=whitespace",
        ],
        Some(request.message.into_bytes()),
        STATUS_LIMIT,
        "Git returned too much output while committing.",
    )?;
    if output.code == Some(0) {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.stderr.trim().is_empty() && !stdout.trim().is_empty() {
        return Err(stdout.trim().to_owned());
    }
    Err(output.failure())
}

#[tauri::command]
pub(crate) async fn git_create_commit(
    repo: String,
    request: CommitRequest,
    expected_root: String,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Workspace>();
        let _operation = state.operations.lock().map_err(error)?;
        let root = files::current_root(&state, &expected_root)?;
        create_commit(&root, &repo, request)
    })
    .await
    .map_err(error)?
}

fn git_text(
    root: &Path,
    args: &[&str],
    limit: usize,
    limit_message: &str,
) -> Result<String, String> {
    let output = run(root, args, limit, limit_message)?;
    if output.code != Some(0) {
        return Err(output.failure());
    }
    String::from_utf8(output.stdout).map_err(error)
}

#[derive(Deserialize, PartialEq, Serialize)]
pub(crate) struct PushTarget {
    remote: String,
    reference: String,
}

#[derive(Serialize)]
pub(crate) struct RemoteStatus {
    remotes: Vec<String>,
    upstream: Option<PushTarget>,
    comparison: Option<UpstreamComparison>,
}

#[derive(Debug, PartialEq, Serialize)]
struct UpstreamComparison {
    ahead: u64,
    behind: u64,
}

fn compare_upstream(root: &Path, branch: &str) -> Option<UpstreamComparison> {
    let reference = format!("refs/heads/{branch}");
    let range = format!("{reference}...{branch}@{{upstream}}");
    let counts = git_text(
        root,
        &["rev-list", "--left-right", "--count", &range, "--"],
        STATUS_LIMIT,
        "The Git upstream comparison exceeds 1 MiB.",
    )
    .ok()?;
    let (ahead, behind) = counts.trim().split_once('\t')?;
    Some(UpstreamComparison {
        ahead: ahead.parse().ok()?,
        behind: behind.parse().ok()?,
    })
}

fn remote_status(root: &Path, branch: &str) -> Result<RemoteStatus, String> {
    let reference = format!("refs/heads/{branch}");
    let refs = git_text(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)",
            "--",
            &reference,
        ],
        STATUS_LIMIT,
        "The Git upstream reference is too long.",
    )?;
    let upstream = refs.lines().find_map(|line| {
        let mut fields = line.split('\0');
        if fields.next()? != reference {
            return None;
        }
        let remote = fields.next()?;
        let reference = fields.next()?;
        (!remote.is_empty() && !reference.is_empty()).then(|| PushTarget {
            remote: remote.into(),
            reference: reference.into(),
        })
    });
    let remotes = git_text(
        root,
        &["remote"],
        STATUS_LIMIT,
        "The Git remote list is too long.",
    )?;
    Ok(RemoteStatus {
        remotes: remotes.lines().map(str::to_owned).collect(),
        upstream,
        comparison: None,
    })
}

#[tauri::command]
pub(crate) async fn git_remote_status(
    repo: String,
    branch: String,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<RemoteStatus, String> {
    let root = files::current_root(&state, &expected_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = select_repository(&root, &repo, true)?;
        let mut status = remote_status(&repo, &branch)?;
        if status.upstream.is_some() {
            status.comparison = compare_upstream(&repo, &branch);
        }
        Ok(status)
    })
    .await
    .map_err(error)?
}

#[derive(Deserialize)]
pub(crate) struct PushRequest {
    branch: String,
    head: String,
    target: PushTarget,
    publish: bool,
}

fn check_branch_head(root: &Path, name: &str, expected_head: &str) -> Result<(), String> {
    let reference = format!("refs/heads/{name}");
    let branch = git_text(
        root,
        &["symbolic-ref", "--quiet", "HEAD"],
        STATUS_LIMIT,
        "The Git branch reference is too long.",
    )?;
    let head = git_text(
        root,
        &["rev-parse", "--verify", "HEAD"],
        STATUS_LIMIT,
        "The Git revision is too long.",
    )?;
    if branch.trim_end() != reference || head.trim_end() != expected_head {
        return Err("The branch changed. Review the refreshed Git panel and try again.".into());
    }
    Ok(())
}

fn push_branch(root: &Path, request: PushRequest) -> Result<(), String> {
    check_branch_head(root, &request.branch, &request.head)?;
    let reference = format!("refs/heads/{}", request.branch);
    let status = remote_status(root, &request.branch)?;
    if !status.remotes.contains(&request.target.remote)
        || !request.target.reference.starts_with("refs/heads/")
    {
        return Err("Choose an available Git remote and branch.".into());
    }
    if request.publish {
        if status.upstream.is_some() || request.target.reference != reference {
            return Err("The branch tracking configuration changed. Review the refreshed Git panel and try again.".into());
        }
    } else if status.upstream.as_ref() != Some(&request.target) {
        return Err("The branch tracking configuration changed. Review the refreshed Git panel and try again.".into());
    }

    let refspec = format!("{reference}:{}", request.target.reference);
    let disable_mirror = format!("remote.{}.mirror=false", request.target.remote);
    let mut args = vec![
        "-c",
        &disable_mirror,
        "push",
        "--porcelain",
        "--no-force",
        "--no-follow-tags",
        "--no-recurse-submodules",
    ];
    if request.publish {
        args.push("--set-upstream");
    }
    args.extend(["--", &request.target.remote, &refspec]);
    let output = run(
        root,
        &args,
        STATUS_LIMIT,
        "Git returned too much output while pushing.",
    )?;
    if output.code == Some(0) {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(rejection) = stdout
        .lines()
        .filter_map(|line| line.strip_prefix("!\t")?.split_once('\t'))
        .map(|(_, reason)| reason)
        .next()
    {
        return Err(format!("{rejection}\n{}", output.failure()));
    }
    Err(output.failure())
}

#[tauri::command]
pub(crate) async fn git_push(
    repo: String,
    request: PushRequest,
    expected_root: String,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Workspace>();
        let _operation = state.operations.lock().map_err(error)?;
        let root = files::current_root(&state, &expected_root)?;
        push_branch(&select_repository(&root, &repo, true)?, request)
    })
    .await
    .map_err(error)?
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase")]
pub(crate) enum ReceiveRequest {
    Fetch {
        remote: String,
    },
    Pull {
        branch: String,
        head: String,
        target: PushTarget,
    },
}

fn fetch_remote(root: &Path, remote: &str, reference: &str) -> Result<(), String> {
    git_text(
        root,
        &[
            "fetch",
            "--no-tags",
            "--no-prune",
            "--no-prune-tags",
            "--no-recurse-submodules",
            "--refmap=",
            "--",
            remote,
            reference,
        ],
        STATUS_LIMIT,
        "Git returned too much output while fetching.",
    )?;
    Ok(())
}

fn require_clean_worktree(root: &Path) -> Result<(), String> {
    let status = git_text(
        root,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
        STATUS_LIMIT,
        "The Git working tree status exceeds 1 MiB.",
    )?;
    if !status.is_empty() {
        return Err(
            "Pull requires a clean working tree. Commit or stash your local changes first.".into(),
        );
    }
    Ok(())
}

fn receive_remote(root: &Path, request: ReceiveRequest) -> Result<(), String> {
    match request {
        ReceiveRequest::Fetch { remote } => {
            if !remote_status(root, "")?.remotes.contains(&remote) {
                return Err("Choose an available Git remote.".into());
            }
            fetch_remote(
                root,
                &remote,
                &format!("+refs/heads/*:refs/remotes/{remote}/*"),
            )
        }
        ReceiveRequest::Pull {
            branch,
            head,
            target,
        } => {
            check_branch_head(root, &branch, &head)?;
            let status = remote_status(root, &branch)?;
            let upstream = target
                .reference
                .strip_prefix("refs/heads/")
                .filter(|_| {
                    status.upstream.as_ref() == Some(&target)
                        && status.remotes.contains(&target.remote)
                })
                .ok_or("The upstream changed. Review the refreshed Git panel and try again.")?;
            require_clean_worktree(root)?;
            let refspec = format!(
                "+{}:refs/remotes/{}/{upstream}",
                target.reference, target.remote
            );
            fetch_remote(root, &target.remote, &refspec)?;
            let revision = format!("refs/remotes/{}/{upstream}", target.remote);
            check_branch_head(root, &branch, &head)?;
            require_clean_worktree(root)?;
            git_text(
                root,
                &[
                    "merge",
                    "--ff-only",
                    "--no-squash",
                    "--no-autostash",
                    "--no-overwrite-ignore",
                    "--",
                    &revision,
                ],
                STATUS_LIMIT,
                "Git returned too much output while pulling.",
            )?;
            Ok(())
        }
    }
}

#[tauri::command]
pub(crate) async fn git_receive(
    repo: String,
    request: ReceiveRequest,
    expected_root: String,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Workspace>();
        let _operation = state.operations.lock().map_err(error)?;
        let root = files::current_root(&state, &expected_root)?;
        receive_remote(&select_repository(&root, &repo, true)?, request)
    })
    .await
    .map_err(error)?
}

fn local_branches(root: &Path) -> Result<Vec<String>, String> {
    let refs = git_text(
        root,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)",
            "refs/heads/",
        ],
        STATUS_LIMIT,
        "The local branch list exceeds 1 MiB.",
    )?;
    Ok(refs
        .lines()
        .filter_map(|line| line.strip_prefix("refs/heads/").map(str::to_owned))
        .collect())
}

#[tauri::command]
pub(crate) async fn git_branches(
    repo: String,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<Vec<String>, String> {
    let root = files::current_root(&state, &expected_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        local_branches(&select_repository(&root, &repo, true)?)
    })
    .await
    .map_err(error)?
}

fn switch_branch(root: &Path, branch: &str) -> Result<(), String> {
    if !local_branches(root)?.iter().any(|name| name == branch) {
        return Err("The selected local branch is no longer available.".into());
    }
    git_text(
        root,
        &[
            "switch",
            "--no-guess",
            "--no-overwrite-ignore",
            "--no-recurse-submodules",
            "--",
            branch,
        ],
        STATUS_LIMIT,
        "Git returned too much output while switching branches.",
    )?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn git_switch(
    repo: String,
    branch: String,
    expected_root: String,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Workspace>();
        let _operation = state.operations.lock().map_err(error)?;
        let root = files::current_root(&state, &expected_root)?;
        switch_branch(&select_repository(&root, &repo, true)?, &branch)
    })
    .await
    .map_err(error)?
}

fn validate_commit(commit: &str) -> Result<(), String> {
    if matches!(commit.len(), 40 | 64) && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Select a valid Git commit.".into())
    }
}

fn history(root: &Path, head: &str, skip: usize) -> Result<Vec<Commit>, String> {
    validate_commit(head)?;
    let page_size = format!("--max-count={}", HISTORY_PAGE + 1);
    let offset = format!("--skip={skip}");
    let mut args = vec![
        "log",
        "--no-color",
        "--no-notes",
        "--no-show-signature",
        "--encoding=UTF-8",
        "-z",
        "--format=%H%x00%s%x00%an%x00%at",
        &page_size,
        &offset,
        head,
        "--",
    ];
    if repository_prefix(root)?.is_some_and(|prefix| !prefix.is_empty()) {
        args.push(".");
    }
    let output = git_text(
        root,
        &args,
        STATUS_LIMIT,
        "The Git history page exceeds 1 MiB.",
    )?;
    let mut fields = output.split_terminator('\0');
    let mut commits = Vec::new();
    while let Some(id) = fields.next() {
        let (Some(subject), Some(author), Some(date)) =
            (fields.next(), fields.next(), fields.next())
        else {
            return Err("Invalid Git history output.".into());
        };
        validate_commit(id)?;
        commits.push(Commit {
            id: id.into(),
            subject: subject.into(),
            author: author.into(),
            date: date.parse().map_err(error)?,
        });
    }
    Ok(commits)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryPage {
    commits: Vec<Commit>,
    has_more: bool,
}

#[tauri::command]
pub(crate) async fn git_history(
    repo: String,
    head: String,
    skip: usize,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<HistoryPage, String> {
    let root = files::current_root(&state, &expected_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut commits = history(&select_repository(&root, &repo, false)?, &head, skip)?;
        let has_more = commits.len() > HISTORY_PAGE;
        commits.truncate(HISTORY_PAGE);
        Ok(HistoryPage { commits, has_more })
    })
    .await
    .map_err(error)?
}

fn commit_files(root: &Path, commit: &str) -> Result<Vec<String>, String> {
    validate_commit(commit)?;
    let output = git_text(
        root,
        &[
            "diff-tree",
            "--root",
            "--first-parent",
            "-m",
            "-r",
            "--no-commit-id",
            "--no-renames",
            "--relative",
            "--name-only",
            "-z",
            commit,
            "--",
            ".",
        ],
        STATUS_LIMIT,
        "The commit file list exceeds 1 MiB.",
    )?;
    Ok(output.split_terminator('\0').map(str::to_owned).collect())
}

fn commit_diff(root: &Path, commit: &str, path: &str) -> Result<String, String> {
    validate_commit(commit)?;
    if path.is_empty()
        || path.contains('\\')
        || !Path::new(path).components().all(
            |part| matches!(part, Component::Normal(name) if !name.eq_ignore_ascii_case(".git")),
        )
    {
        return Err("Select a file inside the repository.".into());
    }
    git_text(
        root,
        &[
            "diff-tree",
            "--root",
            "--first-parent",
            "-m",
            "-r",
            "--no-commit-id",
            "--relative",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--unified=3",
            "-p",
            commit,
            "--",
            path,
        ],
        DIFF_LIMIT,
        "The commit diff exceeds 256 KiB.",
    )
}

#[tauri::command]
pub(crate) async fn git_commit_files(
    repo: String,
    commit: String,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<Vec<String>, String> {
    let root = files::current_root(&state, &expected_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        commit_files(&select_repository(&root, &repo, false)?, &commit)
    })
    .await
    .map_err(error)?
}

#[tauri::command]
pub(crate) async fn git_commit_diff(
    repo: String,
    commit: String,
    path: String,
    expected_root: String,
    state: State<'_, Workspace>,
) -> Result<String, String> {
    let root = files::current_root(&state, &expected_root)?;
    tauri::async_runtime::spawn_blocking(move || {
        commit_diff(&select_repository(&root, &repo, false)?, &commit, &path)
    })
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
    fn publishes_and_pushes_one_branch_and_reports_non_fast_forward_rejections() {
        let temp = tempfile::tempdir().unwrap();
        let work = temp.path().join("work");
        let remote = temp.path().join("remote.git");
        fs::create_dir(&work).unwrap();
        fs::create_dir(&remote).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        git(&remote, &["init", "-q", "--bare"]);
        git(&work, &["config", "user.name", "Leve test"]);
        git(&work, &["config", "user.email", "leve@example.test"]);
        git(&work, &["config", "commit.gpgsign", "false"]);
        git(&work, &["config", "core.hooksPath", ".git/empty-hooks"]);
        git(&work, &["remote", "add", "origin", "../remote.git"]);
        git(&work, &["config", "remote.origin.mirror", "true"]);
        git(&work, &["config", "push.followTags", "true"]);
        fs::write(work.join("file.txt"), "first version\n").unwrap();
        git(&work, &["add", "file.txt"]);
        git(&work, &["commit", "-qm", "First commit"]);
        git(&work, &["branch", "unpublished"]);
        git(&work, &["tag", "-a", "private-tag", "-m", "Not published"]);
        let head = |root: &Path, reference: &str| {
            git_text(
                root,
                &["rev-parse", "--verify", reference],
                STATUS_LIMIT,
                "Unexpected test output",
            )
            .unwrap()
            .trim()
            .to_owned()
        };
        let request = |publish: bool| PushRequest {
            branch: "main".into(),
            head: head(&work, "HEAD"),
            publish,
            target: PushTarget {
                remote: "origin".into(),
                reference: "refs/heads/main".into(),
            },
        };
        assert!(remote_status(&work, "main").unwrap().upstream.is_none());
        push_branch(&work, request(true)).unwrap();
        let upstream = remote_status(&work, "main").unwrap().upstream.unwrap();
        assert_eq!(upstream.remote, "origin");
        assert_eq!(upstream.reference, "refs/heads/main");
        assert_eq!(head(&remote, "refs/heads/main"), head(&work, "HEAD"));
        let refs = git_text(
            &remote,
            &["for-each-ref", "--format=%(refname)"],
            STATUS_LIMIT,
            "Unexpected test output",
        )
        .unwrap();
        assert_eq!(refs.trim(), "refs/heads/main");

        fs::write(work.join("file.txt"), "second version\n").unwrap();
        git(&work, &["add", "file.txt"]);
        git(&work, &["commit", "-qm", "Second commit"]);
        push_branch(&work, request(false)).unwrap();
        let remote_head = head(&remote, "refs/heads/main");
        assert_eq!(remote_head, head(&work, "HEAD"));
        git(&work, &["reset", "--soft", "HEAD^"]);
        assert!(push_branch(&work, request(false))
            .unwrap_err()
            .contains("non-fast-forward"));
        assert_eq!(head(&remote, "refs/heads/main"), remote_head);

        let pull = || ReceiveRequest::Pull {
            branch: "main".into(),
            head: head(&work, "HEAD"),
            target: remote_status(&work, "main").unwrap().upstream.unwrap(),
        };
        assert!(receive_remote(&work, pull())
            .unwrap_err()
            .contains("clean working tree"));
        git(&work, &["reset", "--hard", "HEAD"]);
        let original_head = head(&work, "HEAD");
        receive_remote(
            &work,
            ReceiveRequest::Fetch {
                remote: "origin".into(),
            },
        )
        .unwrap();
        assert_eq!(head(&work, "HEAD"), original_head);
        assert_eq!(head(&work, "refs/remotes/origin/main"), remote_head);
        assert_eq!(
            compare_upstream(&work, "main"),
            Some(UpstreamComparison {
                ahead: 0,
                behind: 1
            })
        );
        receive_remote(&work, pull()).unwrap();
        assert_eq!(head(&work, "HEAD"), remote_head);
        assert_eq!(
            compare_upstream(&work, "main"),
            Some(UpstreamComparison {
                ahead: 0,
                behind: 0
            })
        );
        assert!(fs::read_to_string(work.join("file.txt"))
            .unwrap()
            .contains("second version"));

        git(&work, &["reset", "--hard", "HEAD^"]);
        git(
            &work,
            &["commit", "--allow-empty", "-qm", "Local-only commit"],
        );
        let divergent_head = head(&work, "HEAD");
        assert_eq!(
            compare_upstream(&work, "main"),
            Some(UpstreamComparison {
                ahead: 1,
                behind: 1
            })
        );
        assert!(receive_remote(&work, pull()).is_err());
        assert_eq!(head(&work, "HEAD"), divergent_head);
    }

    #[test]
    fn commits_the_reviewed_index_and_keeps_later_worktree_edits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repo = root.join("app");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.name", "Leve test"]);
        git(&repo, &["config", "user.email", "leve@example.test"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        git(&repo, &["config", "core.autocrlf", "false"]);
        git(&repo, &["config", "core.hooksPath", ".git/empty-hooks"]);
        let file = repo.join("file.txt");
        fs::write(&file, "staged version\n").unwrap();
        git(&repo, &["add", "file.txt"]);
        fs::write(&file, "newer edit\n").unwrap();
        fs::write(repo.join("other.txt"), "untracked\n").unwrap();
        let request = |branch: &str, paths: Vec<String>| CommitRequest {
            branch: branch.into(),
            head: None,
            paths,
            message: "Primeira alteração\n\n#123 Detalhes".into(),
        };
        let paths = vec!["app/file.txt".into()];
        assert!(create_commit(&root, "app", request("other", paths.clone())).is_err());
        assert!(create_commit(&root, "app", request("main", vec![])).is_err());
        assert!(repository_status(&repo, "app")
            .unwrap()
            .unwrap()
            .head
            .is_none());
        create_commit(&root, "app", request("main", paths)).unwrap();
        let show = |format| {
            git_text(
                &repo,
                &["show", format],
                STATUS_LIMIT,
                "Unexpected test output",
            )
            .unwrap()
        };
        assert_eq!(show("HEAD:file.txt"), "staged version\n");
        let message = git_text(
            &repo,
            &["log", "-1", "--format=%B"],
            STATUS_LIMIT,
            "Unexpected test output",
        )
        .unwrap();
        assert_eq!(message.trim_end(), "Primeira alteração\n\n#123 Detalhes");
        assert_eq!(fs::read_to_string(&file).unwrap(), "newer edit\n");
        assert_eq!(
            fs::read_to_string(repo.join("other.txt")).unwrap(),
            "untracked\n"
        );
        let status = repository_status(&repo, "app").unwrap().unwrap();
        assert!(status
            .changes
            .iter()
            .all(|change| change.kind != ChangeKind::Staged));
    }

    #[test]
    fn stages_and_unstages_selected_paths_without_touching_the_worktree() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        let nested = root.join("app");
        fs::create_dir(&nested).unwrap();
        git(&nested, &["init", "-q", "-b", "main"]);
        git(&nested, &["config", "core.autocrlf", "false"]);
        let sub = nested.join("sub");
        fs::create_dir(&sub).unwrap();
        let name = "ação [1].txt";
        fs::write(sub.join(name), "saved contents\n").unwrap();
        fs::write(nested.join("other.txt"), "other nested file\n").unwrap();
        fs::write(root.join("outside.txt"), "outer repository\n").unwrap();
        let path = format!("app/sub/{name}");
        let other = "app/other.txt".to_owned();

        assert!(update_index(&root, "", IndexAction::Stage, std::slice::from_ref(&path)).is_err());
        assert!(update_index(
            &root,
            "app",
            IndexAction::Stage,
            &[path.clone(), "outside.txt".into()]
        )
        .is_err());
        assert_eq!(
            repository_changes(&nested, "")
                .unwrap()
                .iter()
                .filter(|change| change.kind == ChangeKind::Staged)
                .count(),
            0
        );
        update_index(&sub, "", IndexAction::Stage, &[name.into()]).unwrap();
        assert_eq!(
            git_text(
                &nested,
                &["show", &format!(":sub/{name}")],
                STATUS_LIMIT,
                "Unexpected test output"
            )
            .unwrap(),
            "saved contents\n"
        );
        update_index(
            &root,
            "app",
            IndexAction::Stage,
            std::slice::from_ref(&other),
        )
        .unwrap();
        fs::write(sub.join(name), "later worktree edit\n").unwrap();
        update_index(&root, "app", IndexAction::Unstage, &[path, other]).unwrap();
        assert_eq!(
            fs::read_to_string(sub.join(name)).unwrap(),
            "later worktree edit\n"
        );
        assert_eq!(
            fs::read_to_string(nested.join("other.txt")).unwrap(),
            "other nested file\n"
        );
        let repositories = repositories(&root).unwrap();
        assert_eq!(repositories[0].changes.len(), 1);
        assert_eq!(repositories[0].changes[0].path, "outside.txt");
        assert!(repositories[1].head.is_none());
        assert_eq!(repositories[1].changes.len(), 2);
        assert!(repositories[1]
            .changes
            .iter()
            .all(|change| change.kind == ChangeKind::Untracked));
    }

    #[test]
    fn switches_local_branches_and_inspects_commits_without_overwriting_ignored_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        let initial = repositories(&root).unwrap().remove(0);
        assert_eq!(initial.branch.as_deref(), Some("main"));
        assert!(initial.head.is_none());
        assert!(initial.changes.is_empty());

        git(&root, &["config", "user.name", "Leve test"]);
        git(&root, &["config", "user.email", "leve@example.test"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        let folder = root.join("sub");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("file.txt"), "original\n").unwrap();
        fs::write(root.join(".gitignore"), "generated.txt\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "Initial files"]);
        git(&root, &["switch", "-qc", "feature/branch"]);
        fs::write(folder.join("file.txt"), "feature\n").unwrap();
        fs::write(root.join("generated.txt"), "tracked version\n").unwrap();
        git(&root, &["add", "sub/file.txt"]);
        git(&root, &["add", "-f", "generated.txt"]);
        git(&root, &["commit", "-qm", "Feature content"]);
        switch_branch(&root, "main").unwrap();
        assert_eq!(local_branches(&root).unwrap(), ["feature/branch", "main"]);
        assert!(select_repository(&folder, "", true).is_err());

        let ignored = root.join("generated.txt");
        fs::write(&ignored, "local ignored data\n").unwrap();
        assert!(switch_branch(&root, "feature/branch").is_err());
        assert_eq!(
            fs::read_to_string(&ignored).unwrap(),
            "local ignored data\n"
        );
        assert_eq!(
            repositories(&root).unwrap()[0].branch.as_deref(),
            Some("main")
        );
        fs::remove_file(ignored).unwrap();
        switch_branch(&root, "feature/branch").unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("file.txt")).unwrap(),
            "feature\n"
        );

        let feature = repositories(&root).unwrap().remove(0);
        let head = feature.head.unwrap();
        let commits = history(&root, &head, 0).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "Feature content");
        assert_eq!(history(&root, &head, 1).unwrap()[0].id, commits[1].id);
        assert_eq!(commit_files(&folder, &head).unwrap(), ["file.txt"]);
        assert!(commit_diff(&folder, &head, "file.txt")
            .unwrap()
            .contains("+feature"));
        assert!(commit_diff(&root, &commits[1].id, "sub/file.txt")
            .unwrap()
            .contains("+original"));
        git(&root, &["switch", "-q", "--detach", &head]);
        let detached = repositories(&root).unwrap().remove(0);
        assert!(detached.branch.is_none());
        assert_eq!(detached.head.as_deref(), Some(head.as_str()));
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

        update_index(
            &folder,
            "",
            IndexAction::Stage,
            &[name.into(), "deleted.txt".into(), "-".into()],
        )
        .unwrap();
        let staged = changes(&folder).unwrap().unwrap();
        assert_eq!(staged.len(), 3);
        assert!(staged
            .iter()
            .all(|change| change.kind == ChangeKind::Staged));
        update_index(
            &folder,
            "",
            IndexAction::Unstage,
            &[name.into(), "deleted.txt".into(), "-".into()],
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "working\n");
        assert!(!folder.join("deleted.txt").exists());
        assert_eq!(fs::read_to_string(folder.join("-")).unwrap(), "untracked\n");
        assert!(changes(&folder)
            .unwrap()
            .unwrap()
            .iter()
            .all(|change| change.kind != ChangeKind::Staged));
    }
}
