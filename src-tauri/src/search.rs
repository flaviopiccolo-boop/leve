use std::{fs, io::Read, path::Path, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use tauri::State;
use crate::{error, files::checked_path, workspace_root, Workspace};

const MAX_RESULTS: usize = 500;
const MAX_FILES: usize = 5_000;
const MAX_ENTRIES: usize = 20_000;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE: u64 = 1024 * 1024;
const EXCLUDED: &[&str] = &[".git", "node_modules", "target", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".idea"];

#[derive(Default)]
pub struct SearchState(Mutex<Option<(String, Arc<AtomicBool>)>>);

impl SearchState {
    pub fn cancel(&self, id: Option<&str>) {
        if let Ok(mut current) = self.0.lock() {
            if current.as_ref().is_some_and(|(key, _)| id.is_none() || id == Some(key.as_str())) {
                if let Some((_, flag)) = current.take() { flag.store(true, Ordering::Relaxed); }
            }
        }
    }
    fn start(&self, id: String) -> Result<Arc<AtomicBool>, String> {
        let mut current = self.0.lock().map_err(error)?;
        if let Some((_, flag)) = current.take() { flag.store(true, Ordering::Relaxed); }
        let flag = Arc::new(AtomicBool::new(false));
        *current = Some((id, flag.clone()));
        Ok(flag)
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Match { path: String, line: usize, column: usize, length: usize, preview: String, matched_text: String }

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Results { matches: Vec<Match>, scanned: usize, skipped: usize, limit: Option<String> }

fn matcher(query: &str, case_sensitive: bool) -> Result<Regex, String> {
    if query.is_empty() || query.chars().count() > 256 || query.contains(['\n', '\r']) { return Err("Enter 1–256 characters on a single line.".into()); }
    RegexBuilder::new(&regex::escape(query)).case_insensitive(!case_sensitive).build().map_err(error)
}

fn collect_matches(path: &str, text: &str, matcher: &Regex, result: &mut Results, cancelled: &AtomicBool) -> Result<(), String> {
    for (index, line) in text.lines().enumerate() {
        if cancelled.load(Ordering::Relaxed) { return Err("Search cancelled.".into()); }
        for found in matcher.find_iter(line) {
            if result.matches.len() == MAX_RESULTS { result.limit = Some("Result limit reached (500). Narrow your search.".into()); return Ok(()); }
            let before: Vec<char> = line[..found.start()].chars().rev().take(60).collect();
            let after: String = line[found.start()..].chars().take(180).collect();
            let mut preview = before.into_iter().rev().collect::<String>(); preview.push_str(&after);
            result.matches.push(Match { path: path.into(), line: index + 1,
                column: line[..found.start()].encode_utf16().count() + 1,
                length: found.as_str().encode_utf16().count(), preview,
                matched_text: found.as_str().into() });
        }
    }
    Ok(())
}

fn search(root: &Path, query: &str, case_sensitive: bool, cancelled: &AtomicBool) -> Result<Results, String> {
    let matcher = matcher(query, case_sensitive)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut result = Results::default();
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut entries = 0;
    let mut bytes = 0;
    while let Some((directory, depth)) = pending.pop() {
        let items = match fs::read_dir(directory) { Ok(items) => items, Err(_) => { result.skipped += 1; continue; } };
        for item in items {
            if cancelled.load(Ordering::Relaxed) { return Err("Search cancelled.".into()); }
            if Instant::now() >= deadline || entries >= MAX_ENTRIES || result.scanned >= MAX_FILES || bytes >= MAX_BYTES {
                result.limit = Some("Search limit reached (5 seconds, 5,000 files, 20,000 entries or 64 MB). Narrow your search.".into());
                return Ok(result);
            }
            entries += 1;
            let item = match item { Ok(item) => item, Err(_) => { result.skipped += 1; continue; } };
            let path = item.path();
            let name = item.file_name().to_string_lossy().to_lowercase();
            let relative = match path.strip_prefix(root) { Ok(path) => path.to_string_lossy().replace('\\', "/"), Err(_) => continue };
            let path = match checked_path(root, &relative) { Ok(path) => path, Err(_) => { result.skipped += 1; continue; } };
            if path.is_dir() {
                if EXCLUDED.contains(&name.as_str()) { continue; }
                if depth < 15 { pending.push((path, depth + 1)); } else { result.skipped += 1; }
                continue;
            }
            result.scanned += 1;
            let metadata = match fs::metadata(&path) { Ok(metadata) => metadata, Err(_) => { result.skipped += 1; continue; } };
            if !metadata.is_file() || metadata.len() > MAX_FILE { result.skipped += 1; continue; }
            let mut data = Vec::new();
            let read = fs::File::open(&path).and_then(|file| file.take(MAX_FILE + 1).read_to_end(&mut data));
            bytes += data.len() as u64;
            if read.is_err() || data.len() as u64 > MAX_FILE || data.contains(&0) { result.skipped += 1; continue; }
            let text = match String::from_utf8(data) { Ok(text) => text, Err(_) => { result.skipped += 1; continue; } };
            collect_matches(&relative, &text, &matcher, &mut result, cancelled)?;
            if result.limit.is_some() { return Ok(result); }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn search_content(query: String, case_sensitive: bool, id: String, expected_root: String, state: State<'_, Workspace>) -> Result<Results, String> {
    let (root, cancelled) = {
        let _operation = state.operations.lock().map_err(error)?;
        let root = workspace_root(&state)?;
        if dunce::simplified(&root).to_string_lossy() != expected_root { return Err("The project changed. Search again.".into()); }
        (root, state.search.start(id)?)
    };
    tauri::async_runtime::spawn_blocking(move || search(&root, &query, case_sensitive, &cancelled)).await.map_err(error)?
}

#[tauri::command]
pub fn cancel_search(id: String, state: State<'_, Workspace>) { state.search.cancel(Some(&id)); }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_literal_unicode_matches_with_utf16_columns_and_case_options() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("main.py"), "😀 ação( AÇÃO(\r\nlast ação(\n").unwrap();
        let result = search(&root, "ação(", false, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.matches.len(), 3);
        assert_eq!(result.matches[0].column, 4);
        assert_eq!(result.matches[0].length, 5);
        assert_eq!(result.matches[1].matched_text, "AÇÃO(");
        assert_eq!(result.matches[2].line, 2);
        assert_eq!(search(&root, "ação(", true, &AtomicBool::new(false)).unwrap().matches.len(), 2);
    }

    #[test]
    fn skips_dependencies_binary_large_and_non_utf8_files_and_honors_cancellation() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        for dir in [".git", "node_modules", ".venv", "target"] { fs::create_dir(root.join(dir)).unwrap(); fs::write(root.join(dir).join("hidden.txt"), "needle").unwrap(); }
        fs::write(root.join("binary"), b"needle\0").unwrap();
        fs::write(root.join("invalid"), b"needle\xff").unwrap();
        fs::write(root.join("large"), vec![b'x'; MAX_FILE as usize + 1]).unwrap();
        fs::write(root.join("ok"), "needle").unwrap();
        let result = search(&root, "needle", false, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.matches.len(), 1); assert_eq!(result.skipped, 3);
        assert!(search(&root, "needle", false, &AtomicBool::new(true)).is_err());
    }

    #[test]
    fn bounds_results_and_cancels_only_the_matching_request() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("many.txt"), "needle\n".repeat(600)).unwrap();
        let result = search(&root, "needle", false, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.matches.len(), MAX_RESULTS); assert!(result.limit.is_some());
        let state = SearchState::default(); let old = state.start("old".into()).unwrap(); let new = state.start("new".into()).unwrap();
        assert!(old.load(Ordering::Relaxed)); state.cancel(Some("old")); assert!(!new.load(Ordering::Relaxed));
        state.cancel(Some("new")); assert!(new.load(Ordering::Relaxed));
    }
}
