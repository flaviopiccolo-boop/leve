# Product roadmap

The six recommended priorities for making Leve ready for daily use, in order.

- [x] **1. Session recovery — Done:** reopen the last project, restore open files, and recover unsaved changes after a failure. Keep terminal tabs empty at startup.
- [x] **2. File management — Done:** create, rename, and delete files and folders from the explorer. Renaming preserves unsaved buffers; permanent deletion requires confirmation and warns about affected drafts.
- [x] **3. Project-wide content search — Done:** search saved UTF-8 files with literal text and an optional case-sensitive match. Click a result to open and select its location. Searches have exclusions, limits, cancellation, and protection against stale results.
- [ ] **4. Python language support through LSP:** autocomplete, error diagnostics, and go to definition. Start with Python for Django projects.
- [ ] **5. Basic Git integration:** show modified files and view diffs.
- [ ] **6. Distribution and performance:** generate and validate a Windows installer; measure memory usage, startup time, and performance with larger projects.

Session recovery is implemented and has been verified by the user. See the [README](README.md#session-recovery) for its behavior and current limits.

Items 2 and 3 passed automated browser and native backend tests. Complete desktop interaction still needs manual validation.

## Item 4 assessment

Python LSP remains pending. It needs a dedicated integration of a language-server process (such as Pyright), a JSON-RPC transport between Rust and CodeMirror, document synchronization, Python interpreter/virtual-environment configuration, and completion, diagnostic, and definition UI behavior. The integration must also handle file renames, project switching, process shutdown, and server failures, with end-to-end tests against a real Python project. This is substantial enough to implement separately after the file-management and search changes.

References for that work: [CodeMirror LSP client](https://github.com/codemirror/lsp-client) and [Pyright installation](https://github.com/microsoft/pyright/blob/main/docs/installation.md).
