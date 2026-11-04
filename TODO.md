# Product roadmap

The six recommended priorities for making Leve ready for daily use, in order.

- [x] **1. Session recovery — Done:** reopen the last project, restore open files, and recover unsaved changes after a failure. Keep terminal tabs empty at startup.
- [x] **2. File management — Implemented, pending desktop validation:** create, rename, and delete files and folders from the explorer.
- [ ] **3. Project-wide content search:** search text across project files and open matches from clickable results.
- [ ] **4. Python language support through LSP:** autocomplete, error diagnostics, and go to definition. Start with Python for Django projects.
- [ ] **5. Basic Git integration:** show modified files and view diffs.
- [ ] **6. Distribution and performance:** generate and validate a Windows installer; measure memory usage, startup time, and performance with larger projects.

Session recovery is implemented and has been verified by the user. See the [README](README.md#session-recovery) for its behavior and current limits.
