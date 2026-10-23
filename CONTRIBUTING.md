# Contributing

Thanks for helping improve Patent Web. This repository adapts the Rust Patent CLI and TUI from [r14dd/patent](https://github.com/r14dd/patent), so changes must preserve upstream attribution and license notices.

## Development setup

Requirements:

- Node.js 20+ and npm
- Rust 1.88+ with Cargo
- Internet access for Cargo dependencies and upstream search sources
- A C/C++ build toolchain if `node-pty` needs a local native build

Install JavaScript dependencies and start the app:

```bash
npm ci
npm start
```

The web server builds the Rust CLI at startup and listens on `127.0.0.1:4173` by default.

## Before opening a pull request

Run the relevant checks from the repository root:

```bash
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm test
npm run test:web
```

The web smoke test starts the local server if needed and compares the CLI and WebSocket terminal behavior, including resize and keyboard input.

## Pull requests

- Keep changes focused and explain user-visible effects.
- Add or update tests when behavior changes.
- Update README documentation for setup, controls, or configuration changes.
- Never commit API keys, tokens, or real user search queries.
- Keep upstream copyright and license notices intact. See [`NOTICE.md`](NOTICE.md) and the license files.
