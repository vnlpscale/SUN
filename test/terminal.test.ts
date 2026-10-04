import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTerminalText, StreamTextFilter } from '../src/terminal.js';
test('streamed keys are redacted across every possible split', () => {
  const secret = 'test-private-key-123';
  for (let split = 0; split <= secret.length; split++) {
    const filter = new StreamTextFilter(secret);
    const result = filter.write('hello ' + secret.slice(0, split)) + filter.write(secret.slice(split) + ' world') + filter.flush();
    assert.equal(result, 'hello [redacted] world');
  }
});
test('split CSI and OSC sequences never reach the terminal', () => {
  const filter = new StreamTextFilter();
  const result = filter.write('safe\x1b[') + filter.write('2J\x1b]52;c;') + filter.write('clipboard\x1b') + filter.write('\\text\r\n');
  assert.equal(result, 'safetext\n');
  assert.equal(safeTerminalText('a\x9b2Jb\x00c'), 'abc');
});
test('escape fragments inserted inside a secret are normalized before redaction', () => {
  const filter = new StreamTextFilter('fixture-private-key-123');
  assert.equal(filter.write('fixture\x1b[') + filter.write('2J-private-key-123') + filter.flush(), '[redacted]');
});
