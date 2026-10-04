import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools, readWorkspaceFile } from '../src/tools.js';
import type { ConfirmWrite, Memory, ToolRuntime } from '../src/types.js';

const memory: Memory = {
  ingest: () => ({ inserted: 0, duplicates: 0 }), stats: () => ({ chunks: 0, sources: 0, bytes: 0, estimatedTokens: 0 }), close: () => {},
  search: (query, limit) => [{ id: 'hit1', source: 'notes.txt', text: `Relevant ${query}`, score: 1, ordinal: limit ?? 0 }],
};
async function fixture(run: (workspace: string, outside: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'sun-tools-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(workspace); await mkdir(outside);
  try { await run(workspace, outside); }
  finally { await rm(base, { recursive: true, force: true }); }
}
async function execute(runtime: ToolRuntime, name: string, args: unknown): Promise<Record<string, unknown>> {
  return JSON.parse(await runtime.execute({ id: 'call1', name, arguments: JSON.stringify(args) })) as Record<string, unknown>;
}
const deny: ConfirmWrite = async () => false;

test('tool list is narrow, validated, and memory search is bounded', async () => {
  const runtime = createTools(process.cwd(), memory, deny);
  assert.deepEqual(runtime.definitions.map(tool => tool.name), ['search_memory', 'read_file', 'write_file']);
  const hits = await execute(runtime, 'search_memory', { query: 'sun', limit: 2 });
  assert.equal(hits.ok, true);
  assert.deepEqual(hits.hits, [{ id: 'hit1', source: 'notes.txt', ordinal: 2, score: 1, text: 'Relevant sun', truncated: false }]);
  for (const [name, args] of [['exec', { command: 'anything' }], ['search_memory', { query: '', limit: 1 }], ['search_memory', { query: 'x', limit: 9 }], ['search_memory', { query: 'x', extra: 1 }]] as const) {
    assert.equal((await execute(runtime, name, args)).ok, false);
  }
  assert.equal(JSON.parse(await runtime.execute({ id: 'x', name: 'read_file', arguments: 'not-json' })).ok, false);
});

test('read_file reads bounded UTF-8, rejects oversized/binary text and secret paths', async () => {
  await fixture(async workspace => {
    await writeFile(join(workspace, 'notes.txt'), 'SUN ☀ readable');
    await writeFile(join(workspace, 'large.txt'), 'x'.repeat(16 * 1024 + 1));
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([1, 0, 255]));
    await writeFile(join(workspace, '.env'), 'PRIVATE_KEY=do-not-read');
    await mkdir(join(workspace, '.sun')); await writeFile(join(workspace, '.sun', 'session.json'), 'private history');
    const runtime = createTools(workspace, memory, deny);
    assert.deepEqual(await execute(runtime, 'read_file', { path: 'notes.txt' }), { ok: true, path: 'notes.txt', content: 'SUN ☀ readable' });
    for (const path of ['large.txt', 'binary.bin', '.env', '.sun/session.json', '.git/config', '.aws/credentials', 'private.pem']) {
      const output = await execute(runtime, 'read_file', { path });
      assert.equal(output.ok, false, path);
      assert.ok(!JSON.stringify(output).includes('PRIVATE_KEY'));
    }
    assert.equal((await readWorkspaceFile(workspace, 'large.txt', 8 * 1024 * 1024)).length, 16 * 1024 + 1);
    await assert.rejects(readWorkspaceFile(workspace, 'notes.txt', 8 * 1024 * 1024 + 1), /budget/);
  });
});

test('tools deny path traversal, absolute paths, Windows devices and alternate streams', async () => {
  await fixture(async (workspace, outside) => {
    await writeFile(join(outside, 'private.txt'), 'private');
    const runtime = createTools(workspace, memory, deny);
    const paths = ['../outside/private.txt', '..\\outside\\private.txt', '/etc/passwd', 'C:\\Windows\\system.ini', '\\\\server\\share\\file', 'notes.txt:secret', 'NUL', 'file. ', 'folder/../file'];
    for (const path of paths) {
      assert.equal((await execute(runtime, 'read_file', { path })).ok, false, path);
      assert.equal((await execute(runtime, 'write_file', { path, content: 'changed' })).ok, false, path);
    }
    assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'private');
  });
});

test('directory junctions and hard-linked files cannot escape the workspace', async () => {
  await fixture(async (workspace, outside) => {
    await writeFile(join(outside, 'private.txt'), 'private');
    await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await link(join(outside, 'private.txt'), join(workspace, 'hardlink.txt'));
    let approvals = 0;
    const runtime = createTools(workspace, memory, async () => { approvals++; return true; });
    for (const path of ['escape/private.txt', 'escape/new.txt', 'hardlink.txt']) {
      assert.equal((await execute(runtime, 'read_file', { path })).ok, false, path);
      assert.equal((await execute(runtime, 'write_file', { path, content: 'changed' })).ok, false, path);
    }
    assert.equal(approvals, 0);
    assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'private');
  });
});

test('writes are default-deny, preview exact content, and atomically replace after approval', async () => {
  await fixture(async workspace => {
    await writeFile(join(workspace, 'notes.txt'), 'original');
    const denied = createTools(workspace, memory, deny);
    assert.equal((await execute(denied, 'write_file', { path: 'notes.txt', content: 'denied' })).ok, false);
    assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'original');
    const previews: Parameters<ConfirmWrite>[0][] = [];
    const approved = createTools(workspace, memory, async preview => { previews.push(preview); return true; });
    assert.equal((await execute(approved, 'write_file', { path: 'notes.txt', content: 'exact\n☀' })).ok, true);
    assert.equal((await execute(approved, 'write_file', { path: 'new.txt', content: '' })).ok, true);
    assert.deepEqual(previews, [{ path: 'notes.txt', content: 'exact\n☀', existing: true }, { path: 'new.txt', content: '', existing: false }]);
    assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'exact\n☀');
    assert.equal(await readFile(join(workspace, 'new.txt'), 'utf8'), '');
    assert.equal((await readdir(workspace)).filter(name => name.startsWith('.sun-write-')).length, 0);
  });
});

test('write approval cannot be reused after the target changes or a junction is substituted', async () => {
  await fixture(async (workspace, outside) => {
    await writeFile(join(workspace, 'notes.txt'), 'original');
    const changing = createTools(workspace, memory, async () => { await writeFile(join(workspace, 'notes.txt'), 'human changed it'); return true; });
    assert.equal((await execute(changing, 'write_file', { path: 'notes.txt', content: 'overwrite' })).ok, false);
    assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'human changed it');
    await mkdir(join(workspace, 'folder'));
    const swapping = createTools(workspace, memory, async () => {
      await rm(join(workspace, 'folder'), { recursive: true });
      await symlink(outside, join(workspace, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    });
    assert.equal((await execute(swapping, 'write_file', { path: 'folder/new.txt', content: 'do not escape' })).ok, false);
    assert.deepEqual(await readdir(outside), []);
  });
});

test('invalid and oversized writes fail before approval; thrown errors remain sanitized', async () => {
  await fixture(async workspace => {
    let confirmations = 0;
    const runtime = createTools(workspace, memory, async () => { confirmations++; throw new Error('PRIVATE_SECRET'); });
    for (const args of [{ path: 'new.txt', content: 'x'.repeat(65537) }, { path: 'new.txt', content: 'bad\0text' }, { path: 'new.txt', content: '\x1b[2Jhidden' }, { path: 'new.txt', content: '\x9b2Jhidden' }, { path: 'new.txt', content: 7 }, { path: 'missing/child.txt', content: 'x' }]) {
      assert.equal((await execute(runtime, 'write_file', args)).ok, false);
    }
    assert.equal(confirmations, 0);
    const response = await execute(runtime, 'write_file', { path: 'new.txt', content: 'valid' });
    assert.equal(response.ok, false);
    assert.ok(!JSON.stringify(response).includes('PRIVATE_SECRET'));
    assert.deepEqual(await readdir(workspace), []);
  });
});
