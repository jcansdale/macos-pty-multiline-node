/**
 * Minimal Node.js reproduction of macOS PTY multiline write corruption.
 *
 * On macOS, writing multiline data exceeding ~1024 bytes to a PTY in a single
 * write() call corrupts shell input — content after ~byte 1024 wraps and
 * replays earlier buffer data, losing the closing delimiter and leaving the
 * shell stuck in `quote>` mode. This affects all interactive shells on macOS
 * (bash 3.2, bash 5.x, zsh, sh, ksh, dash, csh, tcsh) and does not affect Linux.
 *
 * node-pty ≥1.1.0 works around this by handling EAGAIN via setImmediate, which
 * naturally paces writes. This repro bypasses that by writing directly to the
 * raw PTY master fd using fs.writeSync(), the same as a raw os.write() call.
 * That's the write path that triggers the bug, matching how older versions of
 * node-pty (used by VS Code's fork) behaved before the EAGAIN fix.
 *
 * Each test line is "L01 " + 51 'a' = 55 chars.
 * Command wrapper: `echo '...' | wc -c\n` adds 16 bytes.
 *
 *   18 lines → 1023 bytes (< 1024) → expected to PASS on all platforms
 *   19 lines → 1079 bytes (> 1024) → expected to FAIL on macOS (all shells)
 *
 * Related: https://github.com/microsoft/vscode/issues/296955
 */

'use strict';

const pty  = require('node-pty');
const fs   = require('fs');
const os   = require('os');
const { execFileSync } = require('child_process');

// Shells to probe. Add more paths here as needed.
const CANDIDATE_SHELLS = [
  '/bin/sh',
  '/bin/bash',
  '/bin/zsh',
  '/usr/local/bin/bash',   // Homebrew bash (newer)
  '/opt/homebrew/bin/bash',
  '/usr/local/bin/zsh',
  '/opt/homebrew/bin/zsh',
  '/usr/local/bin/fish',
  '/opt/homebrew/bin/fish',
];

// Raw fd write mode (bypasses CustomWriteStream) or normal shell.write()
// Default: raw fd, which triggers the bug. Set RAW_FD=0 to use shell.write().
const RAW_FD = process.env.RAW_FD !== '0';

function getShellVersion(shellBin) {
  try {
    // fish uses --version, bash/zsh/sh use --version too
    const out = execFileSync(shellBin, ['--version'], { timeout: 2000, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    return out.split('\n')[0].trim();
  } catch {
    return '(unknown version)';
  }
}

function availableShells() {
  // If TEST_SHELL is set, use only that.
  if (process.env.TEST_SHELL) return [process.env.TEST_SHELL];
  return CANDIDATE_SHELLS.filter(s => { try { fs.accessSync(s, fs.constants.X_OK); return true; } catch { return false; } });
}

// Build the test command. Body is numLines × "L01 aaa...aaa" joined by \n.
// Command format: echo '...' | wc -c\n  (same as the original issue repro)
function buildCommand(numLines) {
  const body = Array.from({ length: numLines }, (_, i) =>
    `L${String(i + 1).padStart(2, '0')} ${'a'.repeat(51)}`
  ).join('\n');
  return `echo '${body}' | wc -c\n`;
}

// Expected wc -c output: numLines × 55 chars + (numLines-1) newlines + 1 echo newline
function expectedBytes(numLines) {
  return numLines * 55 + (numLines - 1) + 1;
}

function runTest(numLines, shellBin) {
  return new Promise((resolve) => {
    const shell = pty.spawn(shellBin, [], {
      name: 'xterm',
      cols: 220,   // wide — avoids line-wrap confusing the output
      rows: 50,
      cwd: process.cwd(),
      env: process.env,
    });

    let output  = '';
    let settled = false;

    // Timeout: if the shell is stuck in quote> mode it will never respond.
    // Use 5s to tolerate slower CI runners (shell init takes ~800ms, leaving ~4.2s for output).
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      shell.kill();
      const reason = output.includes('quote>') || output.includes('dquote>')
        ? 'shell stuck in quote mode'
        : 'timeout';
      resolve({ ok: false, reason });
    }, 5000);

    shell.onData((data) => {
      output += data;
      if (settled) return;
      // Strip ANSI escape sequences (e.g. bracketed paste mode codes from bash 5.x)
      // and carriage returns, then match the wc -c digit line.
      const clean = output.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/\r/g, '');
      const m = clean.match(/\n([ \t]*\d+[ \t]*)\n/);
      if (m) {
        settled = true;
        clearTimeout(timer);
        shell.kill();
        resolve({ ok: true, count: parseInt(m[1].trim(), 10) });
      }
    });

    // Give the shell 800ms to initialise before writing the command.
    setTimeout(() => {
      const cmd = buildCommand(numLines);
      if (RAW_FD) {
        // Bypass CustomWriteStream — write directly to the raw PTY master fd.
        // This is the path that triggers the bug (equivalent to a raw os.write() call).
        try { fs.writeSync(shell.fd, Buffer.from(cmd)); } catch (e) {
          if (!settled) { settled = true; clearTimeout(timer); shell.kill(); resolve({ ok: false, reason: `write error: ${e.code || e.message}` }); }
        }
      } else {
        shell.write(cmd);
      }
    }, 800);
  });
}

async function testShell(shellBin) {
  const version = getShellVersion(shellBin);
  const writeMode  = RAW_FD ? 'raw fd (fs.writeSync)' : 'shell.write() via CustomWriteStream';
  console.log(`\nShell    : ${shellBin}`);
  console.log(`Version  : ${version}`);
  console.log(`Write    : ${writeMode}`);
  console.log('Lines  Bytes   Result');
  console.log('─────  ─────── ──────────────────────────────────────');

  let anyFailed = false;
  for (const lines of [5, 10, 18, 19, 20, 25]) {
    const cmd    = buildCommand(lines);
    const expect = expectedBytes(lines);
    const result = await runTest(lines, shellBin);

    let status;
    if (result.ok) {
      const correct = result.count === expect;
      status = correct
        ? `✅  OK  (wc -c = ${result.count})`
        : `⚠️  WRONG COUNT  (got ${result.count}, expected ${expect})`;
      if (!correct) anyFailed = true;
    } else {
      status = `❌  FAILED: ${result.reason}`;
      anyFailed = true;
    }

    console.log(`${String(lines).padEnd(6)} ${String(cmd.length).padEnd(7)} ${status}`);
  }
  return anyFailed;
}

async function main() {
  console.log(`Platform : ${os.platform()} ${os.release()}`);
  console.log(`Node     : ${process.version}`);
  console.log(`node-pty : ${require('./node_modules/node-pty/package.json').version} (${require.resolve('node-pty')})`);

  const shells = availableShells();
  if (shells.length === 0) {
    console.error('No candidate shells found.');
    process.exit(1);
  }

  let anyFailed = false;
  for (const shellBin of shells) {
    const failed = await testShell(shellBin);
    if (failed) anyFailed = true;
  }

  if (anyFailed) {
    console.log('\n❌ One or more tests failed.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
