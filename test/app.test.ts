import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SunApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

test('offline app integrates ingestion, task loop, archive, and restored sessions', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'sun-app-'));
  let app: SunApp | undefined;
  try {
    writeFileSync(path.join(workspace, 'notes.txt'), 'Aster orchard harvest is scheduled for October.');
    app = new SunApp(loadConfig(['--demo', '--workspace', workspace, '--tools'], {}).config);
    await app.command('/ingest notes.txt');
    assert.match(await app.command('/memory orchard'), /file:notes.txt/);
    const result = await app.submit('/task orchard harvest', () => {}, new AbortController().signal);
    assert.equal(result.steps, 2); assert.match(result.text, /SUN demo/);
    assert.ok(result.recalled.length > 0);
    const savedId = app.session().id;
    const chunks = app.memoryStats().chunks;
    await app.command('/new');
    assert.equal(app.session().messages.length, 0); assert.equal(app.memoryStats().chunks, chunks);
    app.close(); app = new SunApp(loadConfig(['--demo', '--workspace', workspace], {}).config);
    await app.command('/resume ' + savedId);
    assert.equal(app.session().messages.at(-1)?.role, 'assistant');
    assert.match(await app.command('/status'), /UNTESTED/);
    await app.command('/tools on'); await app.command('/model speedx2');
    assert.equal(app.config.toolsEnabled, false); assert.equal(app.config.model, 'j-llm/Qwen3.5-2B-SpeedX');
    writeFileSync(path.join(workspace, '.env'), 'private');
    await assert.rejects(app.command('/ingest .env'), /Secret/);
  } finally { app?.close(); rmSync(workspace, { recursive: true, force: true }); }
});
