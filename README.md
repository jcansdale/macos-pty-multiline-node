# macOS PTY Multiline Write Corruption — Node.js Repro

Minimal Node.js reproduction of a macOS PTY bug where writing multiline data
exceeding ~1024 bytes in a single `write()` call corrupts the shell input,
leaving the shell stuck in `quote>` mode.

Related: [microsoft/vscode#296955](https://github.com/microsoft/vscode/issues/296955)

## The Bug

On macOS, when a large multiline command is written to a PTY master fd in one
shot, the kernel's ~1024-byte canonical-mode buffer overflows. Content after
byte 1024 wraps and replays earlier buffer data — the shell's closing
delimiter (`'`, `"`, `EOF`) is lost and the shell gets stuck.

This affects **all shells** tested on macOS (bash 3.2, bash 5.x, zsh, sh, ksh, dash, csh, tcsh) and
does **not** affect Linux.

## Reproduce

```sh
npm install
node repro.js              # raw fd mode (triggers the bug)
RAW_FD=0 node repro.js    # shell.write() mode (mitigated by node-pty)
```

To test a specific shell:

```sh
TEST_SHELL=/bin/bash node repro.js
TEST_SHELL=/opt/homebrew/bin/bash node repro.js
TEST_SHELL=/bin/zsh node repro.js
```

## Write Modes

| Mode | How | Result on macOS |
|---|---|---|
| `RAW_FD=1` (default) | `fs.writeSync()` on raw PTY master fd | ❌ Corrupts at ≥18 lines (~1023 bytes) |
| `RAW_FD=0` | `shell.write()` via node-pty `CustomWriteStream` | ✅ Passes (EAGAIN→setImmediate pacing) |

The raw fd mode matches the write path that exposed the bug before
node-pty's `CustomWriteStream` was introduced (and still matches any code
that writes to a PTY fd directly, e.g. Python's `pty` module).

## Sample Output (macOS, raw fd mode)

```
Platform : darwin 25.3.0
Node     : v23.11.0
node-pty : 1.1.0

Shell    : /bin/zsh
Version  : zsh 5.9 (arm64-apple-darwin25.0)
Write    : raw fd (fs.writeSync)
Lines  Bytes   Result
─────  ─────── ──────────────────────────────────────
5      295     ✅  OK  (wc -c = 280)
10     575     ✅  OK  (wc -c = 560)
18     1023    ✅  OK  (wc -c = 1008)
19     1079    ❌  FAILED: shell stuck in quote mode
20     1135    ❌  FAILED: shell stuck in quote mode
25     1415    ❌  FAILED: shell stuck in quote mode
```

## CI

The GitHub Actions workflow runs a matrix of 8 jobs across all shells × both modes on macOS 15. Raw fd jobs are expected to fail; `shell.write()` jobs are expected to pass.

See [.github/workflows/test.yml](.github/workflows/test.yml).
