# Contributing

Thank you for helping. Small, focused pull requests are easiest to review.

- Node.js 22.5 or newer and git. No runtime or dev dependencies, only the standard library.
- Run `node --test` before you open a pull request. Tests must not use the network.
- Code must run unchanged on Windows, macOS and Linux. Use `path.join`, spawn with argument arrays
  and `shell: false`, and `os.tmpdir()` for temp files.
- A new log format belongs in `src/log/reduce.js` with a test that uses a real log excerpt.
- A prompt change is a new versioned file in `src/prompts/` and a new `PROMPT_VERSION`.
- Decisions that are hard to reverse get an ADR in `docs/adr/`.
- Docs, comments and messages use plain sentences, no dash characters as
  punctuation, no emoji.
