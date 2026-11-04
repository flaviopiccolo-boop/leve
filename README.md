# Leve Editor

An early Windows desktop code editor with a file explorer on the left, an editor in the center, and terminals at the bottom. Panels can be rearranged by dragging their tabs.

“Leve” is the project's working name. Memory usage and performance have not yet been benchmarked against other editors.

## Try the interface

Requires Node.js 22.12+ or 24 and npm.

```powershell
npm install
npm run dev
```

Open http://127.0.0.1:1420. The web preview uses an in-memory demo project. You can edit files, save changes within the session, find files, dock panels, and resize areas. It does not access real folders or run shell commands. Reloading resets demo content while preserving the panel layout.

## Run the Windows app

In addition to Node.js, install the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/):

- Stable Rust with the MSVC toolchain (`rustc` and `cargo` on PATH).
- Microsoft C++ Build Tools with the Desktop development with C++ workload and Windows SDK.
- Microsoft Edge WebView2 Runtime.

```powershell
npm run desktop
```

Select **Open folder** to choose a real project. The explorer loads subfolders as you expand them. Open a file and press **Ctrl+S** to save it. The app always opens without terminal tabs, including when loading layouts from older versions. Click **+** and choose a shell to create and immediately start a focused session. There is no separate Start button. Sessions use the project folder when one is open, or your home folder otherwise. Existing terminal sessions stay open. Press Ctrl and the backtick key to create a PowerShell session directly.

The terminal uses xterm.js in the frontend and portable-pty/ConPTY in Rust. Supported profiles are **PowerShell**, **CMD**, **Git Bash**, and **PowerShell 7**. The desktop app detects installed shells from PATH and common installation locations; unavailable profiles are disabled. Git Bash requires Git for Windows, and PowerShell 7 requires its separate installation. Reopen the picker to refresh detection. The web preview lets you try the picker and tabs without running commands or determining actual availability.

PowerShell starts without a profile and uses UTF-8 input/output. CMD disables AutoRun and switches to UTF-8. Git Bash runs as an interactive login shell and preserves the project directory. The frontend answers cursor-position queries during startup. Workspace paths are converted to a shell-compatible format when possible, so local batch files can retain the correct working directory. Terminal tabs are removed when loading a saved layout; new sessions are always created explicitly through **+** or the keyboard shortcut. Startup errors remain visible in the terminal tab instead of showing a Start button. Browser terminal tabs show an explicit preview message and cannot execute local commands.

Closing a terminal tab, resetting the layout, changing projects, or exiting the app ends the corresponding sessions. Processes that detach from a session may continue running.

Native Windows file drag-and-drop is disabled in the WebView to allow HTML panel dragging. Projects are opened through the folder picker.

## Implemented features

- React and TypeScript frontend with Tauri 2 and Rust.
- Dockable panels using FlexLayout (MIT), adjustable splitters, tab grouping, and split views.
- Saved panel layouts and a reset-to-default action. Built-in panel titles are updated when loading layouts saved by earlier versions.
- Lazy file tree, manual refresh, and file name/path search. The index is limited to 5,000 files and 15 levels, excluding common dependency and build folders.
- CodeMirror 6 editing, undo history, in-file search, and language support loaded on demand.
- File tabs, unsaved-change indicators, discard confirmation, and window-close protection.
- Reading and saving existing files within the selected workspace.
- External-change checks before saving, with a temporary file written in the same directory before replacing the original.
- PowerShell, CMD, Git Bash, and PowerShell 7 profiles with installation detection, byte-stream output, keyboard input, resizing, and cleanup.
- English interface, messages, documentation, and demo content.
- Dark and light themes under **Settings → Appearance**, applied immediately to panels, the editor, and open terminals. The preference is saved locally; switching themes preserves editor history and terminal sessions.
- Last-project and open-file recovery, including the active file, panel arrangement, and unsaved buffers. Terminal tabs remain empty at startup.

## Session recovery

The desktop app checkpoints the current session to its local application data directory, under `recovery/session.json`, roughly every 400 ms while state changes. A normal window close waits for the latest checkpoint. Files in the project are written only when you explicitly save them.

Recovery snapshots are written atomically. A previous valid snapshot is kept in `session.previous.json` and used if the current snapshot cannot be read. The browser preview uses local storage instead of the native recovery files.

On startup, the last project, open file tabs, active file, and docking layout are restored. Unmodified files are read again from disk. Unsaved buffers retain their original disk baseline, so external edits are detected before saving; if the recovered text already matches the disk, it is treated as saved. Missing project folders keep the recovered buffers available with a **Retry recovery** action. Invalid recovery data is preserved until the user explicitly starts a new session.

The status bar shows **Recovery pending**, **Recovery saved**, or **Recovery unavailable**. Write failures display an error and a retry action. A sudden failure can lose edits made since the last completed checkpoint. Native snapshots support up to 100 files, 4 MB per file, and 32 MB total including the saved baselines and layout. Browser storage limits depend on the browser. Undo history and cursor positions are not restored across restarts, and multiple app instances do not coordinate their recovery snapshots.

## Current limitations

- Automated tests cover the web interface and backend operations. Rust tests include a real PowerShell/ConPTY session with UTF-8 output and a batch file running in a folder with spaces and non-ASCII characters. The complete desktop UI flow still requires manual validation.
- UTF-8 text files up to 4 MB. Editing may normalize line endings to LF. Binary files are rejected.
- No file creation, renaming, or deletion; Git integration; LSP; debugging; project-aware autocomplete; extensions; or automatic updates.
- Sidebar search finds file names and paths. Use Ctrl+F to search the contents of the active file.
- No automatic filesystem watching. Refresh the tree manually. A save conflict requires copying your changes and reopening the file.
- Recovery restores the most recent completed checkpoint; it is not a substitute for saving project files or version control.
- Conflict detection is not a transactional lock against another process writing at the same instant.
- Real folders and shells are available only in the desktop app. There is a limit of 16 simultaneous terminal sessions and no automatic reconnection or restart after a shell exits.

## Validate changes

```powershell
npm run build
npm test
```

The browser tests use the installed Google Chrome by default. Set `LEVE_TEST_BROWSER` to another Playwright channel, such as `msedge`, to override it. Tests cover the editor, layouts, themes, terminal creation, and recovery after interruption, external edits, unavailable projects, and invalid snapshots. Screenshots are written to `artifacts/`.

With Rust configured:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run desktop
```

For manual desktop validation: open a real folder; edit, save, and reopen a file; reject an overwrite after an external edit; close a dirty tab; run commands with non-ASCII output; run a local batch file; resize a terminal; interrupt a command with Ctrl+C; and confirm terminal sessions close with their tabs or window.

To build a development executable with the interface embedded, without an installer or web server:

```powershell
npm run desktop:build:dev
```

The output is `src-tauri/target/debug/leve-editor.exe`. This build is not optimized and should not be used to evaluate final resource usage or performance. After installing Rust, open a new terminal so PATH includes Cargo. Close the running editor before replacing its executable.

## Build an installer

```powershell
npm run desktop:build
```

The configuration targets an NSIS installer. Installer generation and behavior still require native validation. Portable packaging, signing, and updates are future work.

## Project structure

- `src/App.tsx`: application shell, docking, navigation, and file state.
- `src/Editor.tsx`: CodeMirror integration and language loading.
- `src/Terminal.tsx`: terminal frontend and Rust communication.
- `src/shells.ts`: terminal profile types and preview data.
- `src/workspace.ts`: workspace access and browser demo.
- `src/session.ts`: session checkpoint coordination and file reconciliation during recovery.
- `src-tauri/src/main.rs`: local operations, saving, and PTY sessions.
- `src-tauri/src/shells.rs`: installed-shell discovery and launch configuration.
- `src-tauri/src/session.rs`: bounded, atomic recovery snapshots and fallback storage.
- `tests/editor.spec.ts`: browser integration tests.

The next product decisions are file-management operations, project-wide content search, the first language to support through LSP, and Git integration.
