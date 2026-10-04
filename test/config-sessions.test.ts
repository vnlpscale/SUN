import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionStore } from '../src/sessions.js';

test('presets never treat 1T metadata as native window', () => {
  assert.equal(loadConfig(['--preset', 'speedx2'], {}).config.model, 'j-llm/Qwen3.5-2B-SpeedX');
  assert.equal(loadConfig([], {}).config.toolsEnabled, false);
  assert.throws(() => loadConfig(['--context', '1000000000000'], {}), /Context/);
  assert.throws(() => loadConfig(['--context', '2048'], {}), /Context/);
  assert.throws(() => loadConfig(['--context', '4096', '--output', '2048', '--tools'], {}), /prompt budget/);
  assert.throws(() => loadConfig(['--preset', 'speedx2', '--context', '32768'], {}), /Context/);
  assert.throws(() => loadConfig(['--model', 'other-model'], {}), /custom/);
  assert.equal(loadConfig(['--preset', 'custom', '--model', 'served-alias', '--tools'], {}).config.model, 'served-alias');
});
test('keys cannot be sent over cleartext remote endpoints or via URL credentials', () => {
  assert.throws(() => loadConfig(['--endpoint', 'http://remote.example/v1'], { SUN_API_KEY: 'test-secret' }), /HTTPS/);
  assert.throws(() => loadConfig(['--endpoint', 'https://user:secret@example.com/v1'], {}), /credentials/);
  assert.throws(() => loadConfig(['--endpoint', 'https://example.com/v1?key=secret'], {}), /query/);
});
test('sessions persist, validate IDs, and prune whole user turns', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sun-sessions-'));
  try {
    const store = new SessionStore(dir); const session = store.create();
    for (let i = 0; i < 110; i++) session.messages.push({ role: 'user', content: String(i) }, { role: 'assistant', content: 'answer' });
    store.save(session);
    const loaded = store.load(session.id);
    assert.equal(loaded.messages.length, 200); assert.equal(loaded.messages[0]?.role, 'user');
    assert.equal(store.list()[0]?.id, session.id); assert.throws(() => store.load('../bad'), /session ID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
