use std::{fs, path::{Component, Path, PathBuf}};
use tauri::State;
use crate::{error, workspace_root, Workspace};

pub(crate) fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}

fn valid_name(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty() || name == "." || name == ".." || name.trim() != name || name.ends_with('.') || name.len() > 240
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || [".", "..", "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&&stem[3..])) {
        return Err("Use a valid Windows file or folder name, without path separators or reserved names.".into());
    }
    Ok(())
}

// Check each existing component, including junctions. Never mutate through links.
pub fn checked_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let mut target = root.to_path_buf();
    for part in Path::new(path).components() {
        match part {
            Component::Normal(name) => {
                let name = name.to_str().ok_or("Invalid path.")?;
                valid_name(name)?;
                target.push(name);
                if linked(&fs::symlink_metadata(&target).map_err(error)?) { return Err("Links and junctions are not supported for this operation.".into()); }
            }
            _ => return Err("The path must stay inside the project folder.".into()),
        }
    }
    let canonical = target.canonicalize().map_err(error)?;
    if !canonical.starts_with(root) { return Err("The path is outside the project folder.".into()); }
    Ok(target)
}

fn child(root: &Path, parent: &str, name: &str) -> Result<PathBuf, String> {
    valid_name(name)?;
    let parent = checked_path(root, parent)?;
    if !parent.is_dir() { return Err("The parent is not a folder.".into()); }
    Ok(parent.join(name))
}

fn relative(root: &Path, path: &Path) -> Result<String, String> {
    Ok(path.strip_prefix(root).map_err(error)?.to_string_lossy().replace('\\', "/"))
}

fn create(root: &Path, parent: &str, name: &str, directory: bool) -> Result<String, String> {
    let target = child(root, parent, name)?;
    if directory { fs::create_dir(&target).map_err(error)?; }
    else { fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(error)?; }
    relative(root, &target)
}

// MoveFileW fails if the destination exists, including a file created concurrently.
#[cfg(windows)]
fn rename_no_replace(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileW(existing: *const u16, new: *const u16) -> i32; }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) } == 0 { return Err(error(std::io::Error::last_os_error())); }
    Ok(())
}

#[cfg(not(windows))]
fn rename_no_replace(source: &Path, target: &Path) -> Result<(), String> {
    if fs::symlink_metadata(target).is_ok() { return Err("A file or folder with that name already exists.".into()); }
    fs::rename(source, target).map_err(error)
}

fn rename(root: &Path, path: &str, name: &str) -> Result<String, String> {
    let source = checked_path(root, path)?;
    if source == root { return Err("The project root cannot be renamed.".into()); }
    let parent = source.parent().ok_or("Invalid parent.")?;
    let target = child(root, &relative(root, parent)?, name)?;
    if source == target { return relative(root, &target); }
    rename_no_replace(&source, &target)?;
    relative(root, &target)
}

fn check_tree(path: &Path, depth: usize, remaining: &mut usize) -> Result<(), String> {
    if depth > 100 || *remaining == 0 { return Err("This folder is too large to delete here. Use Windows Explorer.".into()); }
    *remaining -= 1;
    let metadata = fs::symlink_metadata(path).map_err(error)?;
    if linked(&metadata) { return Err("Remove links or junctions with Windows Explorer before deleting this folder.".into()); }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(error)? { check_tree(&entry.map_err(error)?.path(), depth + 1, remaining)?; }
    }
    Ok(())
}

fn delete(root: &Path, path: &str) -> Result<(), String> {
    let target = checked_path(root, path)?;
    if target == root { return Err("The project root cannot be deleted.".into()); }
    check_tree(&target, 0, &mut 100_000)?;
    if target.is_dir() { fs::remove_dir_all(target).map_err(error) }
    else { fs::remove_file(target).map_err(error) }
}

pub(crate) fn current_root(state: &Workspace, expected_root: &str) -> Result<PathBuf, String> {
    let root = workspace_root(state)?;
    if dunce::simplified(&root).to_string_lossy() != expected_root { return Err("The project changed. Try the operation again.".into()); }
    Ok(root)
}

#[tauri::command]
pub async fn create_entry(parent: String, name: String, directory: bool, expected_root: String, state: State<'_, Workspace>) -> Result<String, String> {
    // Serialize workspace changes and mutations; an old request cannot touch a new project.
    let _operation = state.operations.lock().map_err(error)?;
    create(&current_root(&state, &expected_root)?, &parent, &name, directory)
}

#[tauri::command]
pub async fn rename_entry(path: String, name: String, expected_root: String, state: State<'_, Workspace>) -> Result<String, String> {
    let _operation = state.operations.lock().map_err(error)?;
    rename(&current_root(&state, &expected_root)?, &path, &name)
}

#[tauri::command]
pub async fn delete_entry(path: String, expected_root: String, state: State<'_, Workspace>) -> Result<(), String> {
    let _operation = state.operations.lock().map_err(error)?;
    delete(&current_root(&state, &expected_root)?, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_renames_and_deletes_nested_entries_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        create(&root, "", "ação", true).unwrap();
        create(&root, "ação", "main.py", false).unwrap();
        fs::write(root.join("ação/main.py"), "important").unwrap();
        assert!(create(&root, "ação", "main.py", false).is_err());
        create(&root, "ação", "other.py", false).unwrap();
        assert!(rename(&root, "ação/main.py", "other.py").is_err());
        assert_eq!(fs::read_to_string(root.join("ação/main.py")).unwrap(), "important");
        assert_eq!(rename(&root, "ação", "renamed").unwrap(), "renamed");
        assert_eq!(fs::read_to_string(root.join("renamed/main.py")).unwrap(), "important");
        delete(&root, "renamed").unwrap();
        assert!(!root.join("renamed").exists());
    }

    #[test]
    fn rejects_root_mutation_traversal_and_reserved_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for name in ["", ".", "..", "../escape", "C:\\escape", "NUL.txt", "COM1", "bad.", "a:b", " a"] {
            assert!(create(&root, "", name, false).is_err(), "{name}");
        }
        assert!(delete(&root, "").is_err());
        assert!(rename(&root, "", "new").is_err());
        assert!(create(&root, "../", "escape", true).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_junctions_without_touching_their_targets() {
        use std::os::windows::process::CommandExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap(); fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        let status = std::process::Command::new("cmd").args(["/D", "/C", "mklink", "/J"])
            .arg(root.join("link")).arg(&outside).creation_flags(0x08000000).output().unwrap();
        assert!(status.status.success(), "{:?}", status);
        let root = root.canonicalize().unwrap();
        assert!(create(&root, "link", "bad.txt", false).is_err());
        assert!(delete(&root, "link").is_err());
        assert!(rename(&root, "link/keep.txt", "gone.txt").is_err());
        fs::create_dir(root.join("parent")).unwrap();
        fs::rename(root.join("link"), root.join("parent/link")).unwrap();
        assert!(delete(&root, "parent").is_err());
        assert_eq!(fs::read_to_string(outside.join("keep.txt")).unwrap(), "keep");
        fs::remove_dir(root.join("parent/link")).unwrap();
    }
}
