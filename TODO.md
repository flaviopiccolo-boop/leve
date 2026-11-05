# Product roadmap

The six recommended priorities for making Leve ready for daily use, in order.

- [x] **1. Session recovery — Done:** reopen the last project, restore open files, and recover unsaved changes after a failure. Keep terminal tabs empty at startup.
- [x] **2. File management — Done:** create, rename, and delete files and folders from the explorer. Renaming preserves unsaved buffers; permanent deletion requires confirmation and warns about affected drafts.
- [x] **3. Project-wide content search — Done:** search saved UTF-8 files with literal text and an optional case-sensitive match. Click a result to open and select its location. Searches have exclusions, limits, cancellation, and protection against stale results.
- [x] **4. Language support through LSP — Done.** Python (including Django), TypeScript, and JavaScript support autocomplete, diagnostics, and go to definition. Live ESLint checks JavaScript and TypeScript against the project's rules. Each language and ESLint can be enabled separately per project. The Problems panel shows diagnostics for the active file, with expandable details and JSON copy for individual entries or the entire list.
- [x] **5. Basic Git integration — Done.** The Git panel lists staged, working tree, and untracked changes and opens a read-only unified diff.
- [ ] **6. Distribution and performance:** generate and validate a Windows installer; measure memory usage, startup time, and performance with larger projects.

Session recovery is implemented and has been verified by the user. See the [README](README.md#session-recovery) for its behavior and current limits.

Items 2 and 3 passed automated browser and native backend tests. Complete desktop interaction still needs manual validation.

For setup and verification of item 4, see [language support](README.md#language-support).
