import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sanitizeTerminalText } from '../src/tui.js';

const fixture = fileURLToPath(new URL('./fixtures/tui-fixture.js', import.meta.url));
const environment = { ...process.env, NO_COLOR: '1' };

function plain(input: string): string {
  const child = spawnSync(process.execPath, [fixture], { input, encoding: 'utf8', timeout: 5000, env: environment, windowsHide: true });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  return child.stdout;
}

async function interactive(initial: string, answer?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, '--interactive'], { stdio: ['pipe', 'pipe', 'pipe'], env: environment, windowsHide: true });
    let output = '';
    let errors = '';
    let answered = false;
    let exited = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Terminal fixture did not finish: ' + sanitizeTerminalText(output).slice(-1000) + errors)); }, 5000);
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (!answered && answer !== undefined && output.includes('Approve write? [y/N]')) {
        answered = true;
        // Prequeued y must not have answered the question before this fresh input arrives.
        setTimeout(() => {
          if (output.includes('WRITE_RESULT:approved')) { child.kill(); reject(new Error('Typeahead approved the write.')); return; }
          child.stdin.write(answer);
        }, 30);
      }
      if (!exited && output.includes('WRITE_RESULT:')) { exited = true; child.stdin.end('\x04'); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(errors || `Terminal fixture exited with ${code}.`));
      else resolve(sanitizeTerminalText(output));
    });
    child.stdin.write(initial);
  });
}

test('non-TTY prequeued y cannot approve a proposed write', () => {
  const output = plain('write\ny\n/quit\n');
  assert.match(output, /Write approval requires an interactive terminal/);
  assert.match(output, /WRITE_RESULT:denied/);
  assert.doesNotMatch(output, /WRITE_RESULT:approved|Approve write\?/);
});

test('TUI filters fragmented secrets and terminal controls from streamed output', () => {
  const output = plain('stream\n/quit\n');
  assert.doesNotMatch(output, /fixture-private-key-123|\x1b|\x9b/);
  assert.match(output, /reply alpha \[redacted\] omega/);
  assert.match(output, /API configured/);
  assert.doesNotMatch(output, /CONNECTED/);
});

test('write approval displays complete exact content and ignores prequeued y', { timeout: 10_000 }, async () => {
  const output = await interactive('write\ry\r', 'y\r');
  assert.match(output, /Target \(quoted\): "notes.txt"/);
  assert.match(output, /VISIBLE_REVIEW_TAIL/);
  assert.match(output, /WRITE_RESULT:approved/);
  const quoted = output.split('\n').filter(line => line.startsWith('"'));
  const recovered = quoted.map(line => JSON.parse(line) as string).join('');
  const hash = /WRITE_CONTENT_SHA256:([a-f0-9]{64})/.exec(output)?.[1];
  assert.equal(createHash('sha256').update(recovered).digest('hex'), hash, 'Displayed segments must reconstruct the entire proposed file.');
});

test('Ctrl+C at approval denies the write and cancels the turn', { timeout: 10_000 }, async () => {
  const output = await interactive('write\r', '\x03');
  assert.match(output, /WRITE_RESULT:denied/);
  assert.match(output, /Stopping the current turn/);
  assert.match(output, /cancelled/);
});

test('control-bearing write content is denied before it can be displayed or approved', { timeout: 10_000 }, async () => {
  const output = await interactive('write-control\r');
  assert.match(output, /Content must be printable UTF-8 text/);
  assert.match(output, /WRITE_RESULT:denied/);
  assert.doesNotMatch(output, /unsafe|Approve write\?/);
});
