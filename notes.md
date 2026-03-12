# macOS PTY Multiline Write Corruption — Investigation Notes

Related issue: https://github.com/microsoft/vscode/issues/296955

## The Bug

On macOS, writing multiline data exceeding ~1024 bytes to a PTY master fd in a
single `write()` call corrupts the input. Content after ~byte 1024 replays
earlier buffer data, the shell's closing delimiter (`'`, `"`, `EOF`) is lost,
and the shell gets stuck in `quote>` / `heredoc>` mode. Every subsequent write
is swallowed by the broken quote.

Affects: both `/bin/bash` (v3.2, Apple-shipped) and `/bin/zsh` on macOS.
Does not affect Linux.

## Root Cause

The macOS PTY canonical-mode line editor creates backpressure when multiline
input is written faster than the shell's readline loop can echo and process it.
The kernel's ~1024-byte buffer overflows and wraps, corrupting the remainder.
This is a macOS platform behaviour, not specific to any one shell.

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

## What Triggers the Bug

Bypassing `CustomWriteStream` and writing to the raw PTY master fd directly —
e.g. `fs.writeSync(shell.fd, buf)` — reliably triggers the corruption for
multiline payloads >1024 bytes. This is equivalent to a raw `os.write()` call
(as used by Python's `pty` module).

This is the relevant write path for:
- The VS Code `run_in_terminal` tool (some older code paths)
- Python's `pty.openpty()` + `os.write()` direct PTY writes

## Repro Summary (this repo)

`repro.js` spawns a shell via node-pty and writes the test command using
`fs.writeSync()` on the raw fd (`shell.fd`), bypassing `CustomWriteStream`.

```
TEST_SHELL=/bin/bash node repro.js   # bash: fails at ≥19 lines (>1023 bytes)
node repro.js                        # zsh:  fails at ≥19 lines (>1023 bytes)
```

Switching to `shell.write()` (the normal node-pty API) passes all sizes on
both 1.1.0 and v1.2.0-beta.10 because `CustomWriteStream` handles EAGAIN.

## Test Results

| Write method          | node-pty ver   | bash  | zsh   |
|-----------------------|----------------|-------|-------|
| `fs.writeSync()` raw  | any            | ❌    | ❌    |
| `shell.write()`       | 1.1.0          | ✅    | ✅    |
| `shell.write()`       | v1.2.0-beta.10 | ✅    | ✅    |

## VS Code Issue Thread Summary

- @Tyriar rejected the proposed chunked-write fix in PR #298993, arguing the
  failure is specific to ancient bash 3.2 and shouldn't be worked around.
- The `CustomWriteStream` EAGAIN fix in node-pty already mitigates the issue
  for code using `shell.write()`. The remaining exposure is in paths that write
  to the PTY fd directly.
