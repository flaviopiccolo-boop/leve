# Contributing to Leve

Bug reports, fixes, documentation, and feature ideas are welcome. Check the [existing issues](https://github.com/flaviopiccolo-boop/leve/issues) first. For a bug report, include the Leve and Windows versions, steps to reproduce, and what you expected to happen. Open an issue to discuss larger changes before starting work.

1. Fork the repository and create a branch from `main`.
2. Install Node.js 24 and run `npm ci`. To run the native app, follow the [Windows setup in the README](README.md#run-from-source-on-windows).
3. Run the relevant checks below and describe how you verified the change.
4. Open a pull request against `main`. Explain what changed and why, link any related issue, and respond to review feedback.

Run `npm test` for the frontend build and Playwright tests. It uses installed Google Chrome by default. To run with the same browser as CI, install Chromium with `npx playwright install chromium` and set `LEVE_TEST_BROWSER` to `chromium`.

On Windows with the Rust MSVC toolchain installed, run `npm run build`, then `cargo test --locked --manifest-path src-tauri/Cargo.toml` for the native tests. If you change native behavior or the desktop UI, also run `npm run desktop` and follow the relevant [manual checks](README.md#validate-changes).

The GitHub **Web** and **Windows** checks run on pull requests. Contributions are made under the project's [MIT license](LICENSE).
