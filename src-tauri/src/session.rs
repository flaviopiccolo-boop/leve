use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Manager, State};

const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Default)]
pub struct SessionStore(pub Mutex<()>);

#[derive(Serialize, Deserialize)]
pub struct RecoveryFile {
    path: String,
    name: String,
    content: String,
    saved: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    image: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    version: u8,
    root: Option<String>,
    files: Vec<RecoveryFile>,
    active_file: String,
    layout: serde_json::Value,
}

fn validate(session: &Session) -> Result<(), String> {
    if session.version != 1 { return Err("Unsupported recovery format.".into()); }
    if session.files.len() > 100 { return Err("Recovery supports up to 100 open files.".into()); }
    if session.files.iter().any(|file| file.path.is_empty() || file.content.len() > 4 * 1024 * 1024 || file.saved.len() > 4 * 1024 * 1024) {
        return Err("A recovery file exceeds the 4 MB limit.".into());
    }
    if session.files.iter().any(|file| file.image && (!file.content.is_empty() || !file.saved.is_empty())) {
        return Err("Image previews cannot contain recovery text.".into());
    }
    Ok(())
}

fn read(path: &Path) -> Result<Session, String> {
    let mut data = Vec::new();
    fs::File::open(path).map_err(|e| e.to_string())?.take(MAX_BYTES + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_BYTES { return Err("Recovery data exceeds 32 MB.".into()); }
    let session: Session = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    validate(&session)?;
    Ok(session)
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("Invalid recovery directory.")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temporary.write_all(data).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn load(path: &Path) -> Result<Option<Session>, String> {
    let backup = path.with_extension("previous.json");
    if !path.exists() && !backup.exists() { return Ok(None); }
    read(path).or_else(|_| read(&backup)).map(Some)
        .map_err(|_| "Could not read recovery data. Existing recovery files have been preserved.".into())
}

fn save(path: &Path, session: &Session) -> Result<(), String> {
    validate(session)?;
    let data = serde_json::to_vec(session).map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_BYTES { return Err("Recovery data exceeds 32 MB. Save or close some files.".into()); }
    // Only replace the previous copy with a valid, fully decoded snapshot.
    if let Ok(previous) = read(path) {
        atomic_write(&path.with_extension("previous.json"), &serde_json::to_vec(&previous).map_err(|e| e.to_string())?)?;
    }
    atomic_write(path, &data)
}

fn location(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|directory| directory.join("recovery/session.json")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_load(app: tauri::AppHandle, state: State<'_, SessionStore>) -> Result<Option<Session>, String> {
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    load(&location(&app)?)
}

#[tauri::command]
pub async fn session_save(app: tauri::AppHandle, session: Session, state: State<'_, SessionStore>) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    save(&location(&app)?, &session)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(content: &str) -> Session {
        Session { version: 1, root: Some("C:\\project".into()), files: vec![RecoveryFile { path: "main.py".into(), name: "main.py".into(), content: content.into(), saved: "on disk".into(), image: false }], active_file: "main.py".into(), layout: serde_json::json!({}) }
    }

    #[test]
    fn preserves_unsaved_content_and_original_disk_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recovery/session.json");
        save(&path, &snapshot("unsaved ação")).unwrap();
        let restored = load(&path).unwrap().unwrap();
        assert_eq!(restored.files[0].content, "unsaved ação");
        assert_eq!(restored.files[0].saved, "on disk");
    }

    #[test]
    fn falls_back_to_previous_valid_snapshot_when_current_is_corrupt() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.json");
        save(&path, &snapshot("first draft")).unwrap();
        save(&path, &snapshot("second draft")).unwrap();
        fs::write(&path, "broken JSON").unwrap();
        assert_eq!(load(&path).unwrap().unwrap().files[0].content, "first draft");
        let mut invalid = snapshot("invalid"); invalid.version = 99;
        assert!(save(&path, &invalid).is_err());
        assert_eq!(load(&path).unwrap().unwrap().files[0].content, "first draft");
    }
}
