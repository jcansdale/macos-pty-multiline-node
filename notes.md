# macOS PTY Multiline Write Corruption — Investigation Notes

Related issue: https://github.com/microsoft/vscode/issues/296955
This repo: https://github.com/jcansdale/macos-pty-multiline-node

## The Bug

On macOS, writing multiline data exceeding ~1024 bytes to a PTY master fd in a
single `write()` call corrupts the input. Content after ~byte 1024 replays
earlier buffer data, the shell's closing delimiter (`'`, `"`, `EOF`) is lost,
and the shell gets stuck in `quote>` / `heredoc>` mode. Every subsequent write
is swallowed by the broken quote.

Affects: all shells tested on macOS — `/bin/bash` (v3.2), Homebrew bash (5.3.9),
and `/bin/zsh` (5.9). Does not affect Linux.

## Root Cause

The macOS PTY canonical-mode line editor creates backpressure when multiline
input is written faster than the shell's readline loop can echo and process it.
The kernel's ~1024-byte buffer overflows and wraps, corrupting the remainder.
This is a macOS platform behaviour — **not specific to bash 3.2**.

## node-pty's Existing Mitigation

`node-pty ≥1.1.0` introduced `CustomWriteStream` (in `lib/unixTerminal.js`)
which calls `fs.write()` asynchronously and retries on `EAGAIN` via
`setImmediate`. This naturally paces writes and drains the backpressure,
preventing corruption — so `shell.write()` works fine even for large multiline
commands on both 1.1.0 and the VS Code fork `v1.2.0-beta.10`.

The `CustomWriteStream` source even contains an explicit comment:

> "old versions of bash, like v3.2 which ships in macOS, appears to have a bug
> in its readline implementation that causes data corruption when writes to the
> pty happens too quickly. Instead of trying to workaround that we just accept
> it so that large pastes are as fast as possible."
> — https://github.com/microsoft/node-pty/issues/833

This comment is **incorrect** — the bug reproduces identically on Homebrew
bash 5.3.9, confirming it is a macOS PTY platform issue, not a bash 3.2 bug.

## What Triggers the Bug

Bypassing `CustomWriteStream` and writing to the raw PTY master fd directly —
e.g. `fs.writeSync(shell.fd, buf)` — reliably triggers the corruption for
multiline payloads >1024 bytes. This is equivalent to a raw `os.write()` call
(as used by Python's `pty` module).

This is the relevant write path for:
- Python's `pty.openpty()` + `os.write()` direct PTY writes
- Any code that obtains the raw PTY fd and writes to it without pacing

## VS Code's Write Path

VS Code's `terminalProcess.ts` calls `this._ptyProcess!.write(data)` — which
goes through node-pty's `CustomWriteStream`. It does **not** use raw fd writes.
So VS Code's own write path is already protected by the EAGAIN mitigation.

## Repro Summary (this repo)

`repro.js` spawns a shell via node-pty and writes the test command either via:
- `fs.writeSync(shell.fd, buf)` — raw fd, bypasses `CustomWriteStream` (default, `RAW_FD=1`)
- `shell.write(cmd)` — normal node-pty API, goes through `CustomWriteStream` (`RAW_FD=0`)

```sh
node repro.js                        # raw fd — fails at ≥18 lines (~1023 bytes) on macOS
RAW_FD=0 node repro.js              # shell.write() — passes all sizes
TEST_SHELL=/bin/bash node repro.js  # specify a shell explicitly
```

## Test Results

| Write method          | Shell              | Result on macOS (≥18 lines) |
|-----------------------|--------------------|-----------------------------|
| `fs.writeSync()` raw  | bash 3.2 (macOS)   | ❌ fails                    |
| `fs.writeSync()` raw  | bash 5.3.9 (Homebrew) | ❌ fails                 |
| `fs.writeSync()` raw  | zsh 5.9            | ❌ fails                    |
| `shell.write()`       | all of the above   | ✅ passes                   |

node-pty versions tested: 1.1.0, v1.2.0-beta.10 — both pass with `shell.write()`.

## CI

GitHub Actions workflow (`.github/workflows/test.yml`) runs a matrix of 8 jobs
on macOS 15: 4 shells × 2 write modes. Raw fd jobs are expected to fail;
`shell.write()` jobs are expected to pass.

## VS Code Issue Thread Summary

- @Tyriar rejected the proposed chunked-write fix in PR #298993, arguing the
  failure is specific to ancient bash 3.2 and shouldn't be worked around.
- This is incorrect — Homebrew bash 5.3.9 fails identically (confirmed locally).
- VS Code's actual write path (`shell.write()` via `CustomWriteStream`) is
  already protected. The remaining exposure is code that writes to the PTY fd
  directly (e.g. Python `pty` module repros).
