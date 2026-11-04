use std::{fs, io::ErrorKind, path::{Path, PathBuf}};

fn error(err: impl std::fmt::Display) -> String { err.to_string() }

pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative).canonicalize().map_err(error)?;
    if !candidate.starts_with(root) {
        return Err("The path is outside the project folder.".into());
    }
    Ok(candidate)
}

/// Keep this in sync with `validateName` in `src/workspace.ts`.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() { return Err("Enter a name.".into()); }
    if name == "." || name == ".." { return Err("This name is not allowed.".into()); }
    if name.chars().count() > 255 { return Err("The name is too long.".into()); }
    if name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return Err("A name cannot contain < > : \" / \\ | ? *".into());
    }
    if name.ends_with(' ') || name.ends_with('.') { return Err("A name cannot end with a space or period.".into()); }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let numbered = |prefix: &str| stem.strip_prefix(prefix).is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'));
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) || numbered("COM") || numbered("LPT") {
        return Err("Windows reserves this name.".into());
    }
    Ok(())
}

fn split(relative: &str) -> Result<(String, String), String> {
    let normalized = relative.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let (parent, name) = normalized.rsplit_once('/').unwrap_or(("", normalized));
    if name.is_empty() || name == "." || name == ".." { return Err("Select a file or folder inside the project.".into()); }
    Ok((parent.to_string(), name.to_string()))
}

/// Resolves only the parent, so the entry itself is never followed if it is a link
/// and the operation cannot reach the project root.
fn entry_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let (parent, name) = split(relative)?;
    let directory = resolve(root, &parent)?;
    if !directory.is_dir() { return Err("The parent folder is not available.".into()); }
    Ok(directory.join(name))
}

fn new_entry_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_name(&split(relative)?.1)?;
    entry_path(root, relative)
}

fn already_exists(err: std::io::Error) -> String {
    if err.kind() == ErrorKind::AlreadyExists { "A file or folder with this name already exists.".into() } else { error(err) }
}

fn exists(path: &Path) -> bool { fs::symlink_metadata(path).is_ok() }

pub fn create_file(root: &Path, relative: &str) -> Result<(), String> {
    // create_new is atomic and never truncates an existing file.
    fs::OpenOptions::new().write(true).create_new(true).open(new_entry_path(root, relative)?).map(drop).map_err(already_exists)
}

pub fn create_directory(root: &Path, relative: &str) -> Result<(), String> {
    fs::create_dir(new_entry_path(root, relative)?).map_err(already_exists)
}

/// Renames within the same folder and returns the new relative path.
pub fn rename(root: &Path, relative: &str, new_name: &str) -> Result<String, String> {
    validate_name(new_name)?;
    let source = entry_path(root, relative)?;
    if !exists(&source) { return Err("This file or folder no longer exists.".into()); }
    let (parent, name) = split(relative)?;
    let renamed = if parent.is_empty() { new_name.to_string() } else { format!("{parent}/{new_name}") };
    if name == new_name { return Ok(renamed); }
    let target = source.with_file_name(new_name);
    // A case-only rename reaches the same entry on case-insensitive file systems.
    let same_entry = name.to_lowercase() == new_name.to_lowercase() && target.canonicalize().ok() == source.canonicalize().ok();
    // fs::rename would silently replace an existing file on Windows.
    if exists(&target) && !same_entry { return Err("A file or folder with this name already exists.".into()); }
    fs::rename(source, target).map_err(error)?;
    Ok(renamed)
}

/// Moves an entry to the Recycle Bin and never falls back to permanent deletion.
pub fn delete(root: &Path, relative: &str) -> Result<(), String> {
    let source = entry_path(root, relative)?;
    if !exists(&source) { return Err("This file or folder no longer exists.".into()); }
    trash::delete(dunce::simplified(&source)).map_err(|err| format!("Could not move it to the Recycle Bin: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (tempfile::TempDir, PathBuf) {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("project ação");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        (base, root)
    }

    #[test]
    fn rejects_invalid_names() {
        for name in ["", ".", "..", "a/b", "a\\b", "a:b", "a?", "a*", "end.", "end ", "CON", "con.txt", "nul", "COM1", "lpt9.log", "tab\tname"] {
            assert!(validate_name(name).is_err(), "{name:?} should be rejected");
        }
        for name in ["main.py", ".gitignore", "ação.txt", "COM0", "COMMON.txt", "console.log", "a b"] {
            assert!(validate_name(name).is_ok(), "{name:?} should be accepted");
        }
    }

    #[test]
    fn creates_files_and_folders_without_overwriting() {
        let (_base, root) = project();
        create_directory(&root, "src").unwrap();
        create_file(&root, "src/main.py").unwrap();
        fs::write(root.join("src/main.py"), "keep").unwrap();
        assert!(create_file(&root, "src/main.py").unwrap_err().contains("already exists"));
        assert!(create_directory(&root, "src").unwrap_err().contains("already exists"));
        assert_eq!(fs::read_to_string(root.join("src/main.py")).unwrap(), "keep");
    }

    #[test]
    fn stays_inside_the_project() {
        let (base, root) = project();
        fs::write(base.path().join("outside.txt"), "private").unwrap();
        assert!(create_file(&root, "../created.txt").is_err());
        assert!(create_directory(&root, "../created").is_err());
        assert!(rename(&root, "../outside.txt", "moved.txt").is_err());
        assert!(rename(&root, "", "moved").is_err());
        assert!(rename(&root, ".", "moved").is_err());
        assert!(rename(&root, "..", "moved").is_err());
        assert!(delete(&root, "../outside.txt").is_err());
        assert!(delete(&root, "").is_err());
        assert!(delete(&root, ".").is_err());
        assert!(base.path().join("outside.txt").exists());
        assert!(root.exists());
        assert!(!base.path().join("created.txt").exists());
    }

    #[test]
    fn renames_entries_without_replacing_others() {
        let (_base, root) = project();
        create_directory(&root, "src").unwrap();
        fs::write(root.join("src/a.py"), "a").unwrap();
        fs::write(root.join("src/b.py"), "b").unwrap();
        assert!(rename(&root, "src/a.py", "b.py").unwrap_err().contains("already exists"));
        assert!(rename(&root, "src/a.py", "../c.py").is_err());
        assert_eq!(fs::read_to_string(root.join("src/b.py")).unwrap(), "b");
        assert_eq!(rename(&root, "src/a.py", "c.py").unwrap(), "src/c.py");
        assert_eq!(fs::read_to_string(root.join("src/c.py")).unwrap(), "a");
        assert_eq!(rename(&root, "src", "app").unwrap(), "app");
        assert!(root.join("app/c.py").exists());
        assert_eq!(rename(&root, "app/c.py", "C.py").unwrap(), "app/C.py");
        assert!(fs::read_dir(root.join("app")).unwrap().any(|item| item.unwrap().file_name() == "C.py"));
    }

    #[cfg(unix)]
    #[test]
    fn renames_a_link_and_not_its_target() {
        let (base, root) = project();
        fs::write(base.path().join("outside.txt"), "private").unwrap();
        std::os::unix::fs::symlink(base.path().join("outside.txt"), root.join("link.txt")).unwrap();
        rename(&root, "link.txt", "renamed.txt").unwrap();
        assert!(base.path().join("outside.txt").exists());
        assert!(fs::symlink_metadata(root.join("renamed.txt")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn moves_folders_out_of_the_project_with_their_contents() {
        let (_base, root) = project();
        create_directory(&root, "old").unwrap();
        create_file(&root, "old/file.txt").unwrap();
        delete(&root, "old").unwrap();
        assert!(!root.join("old").exists());
        assert!(root.exists());
    }

    #[test]
    fn reports_missing_entries() {
        let (_base, root) = project();
        assert!(rename(&root, "missing.txt", "new.txt").unwrap_err().contains("no longer exists"));
        assert!(delete(&root, "missing.txt").unwrap_err().contains("no longer exists"));
    }
}
