import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteMemory } from '../src/memory.js';

function diskFixture(): { directory: string; path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'sun-memory-test-'));
  return {
    directory, path: join(directory, 'memory.sqlite'),
    cleanup: () => {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(directory.split(/[\\/]/).at(-1)?.startsWith('sun-memory-test-'));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('hash dedupe keeps separate source provenance and idempotent re-ingestion', () => {
  const memory = new SqliteMemory(':memory:');
  try {
    const text = 'Project Aurora uses an amber deployment gate.';
    assert.deepEqual(memory.ingest(text, 'notes/a.txt'), { inserted: 1, duplicates: 0 });
    assert.deepEqual(memory.ingest(text, 'notes/b.txt'), { inserted: 0, duplicates: 1 });
    assert.deepEqual(memory.ingest(text, 'notes/a.txt'), { inserted: 0, duplicates: 1 });
    const hits = memory.search('Aurora deployment');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.source, 'notes/a.txt | notes/b.txt');
    assert.deepEqual(memory.provenance(hits[0]!.id), [
      { source: 'notes/a.txt', ordinal: 0 }, { source: 'notes/b.txt', ordinal: 0 },
    ]);
    const bytes = Buffer.byteLength(text, 'utf8');
    assert.deepEqual(memory.stats(), { chunks: 1, sources: 2, bytes, estimatedTokens: Math.ceil(bytes / 4) });
  } finally { memory.close(); }
});

test('duplicate passages preserve positions within one source', () => {
  const memory = new SqliteMemory(':memory:', { chunkChars: 128 });
  try {
    const repeated = 'archive '.repeat(16);
    assert.equal(repeated.length, 128);
    assert.deepEqual(memory.ingest(repeated + repeated, 'log'), { inserted: 1, duplicates: 1 });
    const hit = memory.search('archive')[0]!;
    assert.deepEqual(memory.provenance(hit.id), [{ source: 'log', ordinal: 0 }, { source: 'log', ordinal: 1 }]);
    assert.equal(memory.stats().chunks, 1);
    assert.deepEqual(memory.provenance(hit.id, 1, 1), [{ source: 'log', ordinal: 1 }]);
  } finally { memory.close(); }
});

test('source snapshots replace stale passages and preserve chunks shared by other sources', () => {
  const memory = new SqliteMemory(':memory:');
  try {
    const original = 'Oldport launch date is March.';
    memory.ingest(original, 'schedule');
    memory.ingest(original, 'archive');
    const oldId = memory.search('Oldport')[0]!.id;
    memory.ingest('Newport launch date is June.', 'schedule');
    assert.deepEqual(memory.provenance(oldId), [{ source: 'archive', ordinal: 0 }]);
    assert.equal(memory.search('Oldport')[0]?.source, 'archive');
    assert.equal(memory.stats().chunks, 2);
    memory.ingest('', 'archive');
    assert.deepEqual(memory.search('Oldport'), []);
    assert.equal(memory.stats().chunks, 1);
    assert.equal(memory.stats().sources, 1);
    const remaining = 'Newport launch date is June.';
    assert.equal(memory.stats().bytes, Buffer.byteLength(remaining));
  } finally { memory.close(); }
});

test('relevance favors query coverage; diversity reduces repetitive and adjacent recall', () => {
  const memory = new SqliteMemory(':memory:');
  try {
    memory.ingest('Orion observatory telescope calibration uses a precision laser and a sapphire mirror.', 'lab/a');
    memory.ingest('Orion observatory telescope calibration uses a precision laser and a sapphire mirror today.', 'lab/b');
    memory.ingest('Orion telescope calibration requires humidity readings before sunset and staff approval.', 'operations');
    memory.ingest('A telescope appears in a general astronomy glossary.', 'glossary');
    const hits = memory.search('Orion telescope calibration', 3);
    assert.equal(hits.length, 3);
    assert.ok(hits[0]!.text.includes('Orion'));
    assert.ok(hits.slice(0, 2).some(hit => hit.source === 'operations'));
    assert.equal(hits.slice(0, 2).filter(hit => hit.source.startsWith('lab/')).length, 1);
    assert.ok(!hits.slice(0, 2).some(hit => hit.source === 'glossary'));
    assert.ok(hits.every(hit => Number.isFinite(hit.score) && hit.score > 0));
  } finally { memory.close(); }
});

test('many provenance copies do not crowd unique retrieval candidates', () => {
  const memory = new SqliteMemory(':memory:');
  try {
    for (let i = 0; i < 40; i++) memory.ingest('Cedar runway operations include a safety checklist.', `copy/${i}`);
    memory.ingest('Cedar runway operations require an inspection of the lights.', 'independent');
    const hits = memory.search('Cedar runway operations', 6);
    assert.equal(hits.length, 2);
    assert.ok(hits.some(hit => hit.source === 'independent'));
    const duplicated = hits.find(hit => hit.text.includes('checklist'))!;
    assert.equal(memory.provenance(duplicated.id).length, 40);
    assert.ok(duplicated.source.includes('more sources'));
    assert.equal(memory.stats().chunks, 2);
    assert.equal(memory.stats().sources, 41);
  } finally { memory.close(); }
});

test('bounded conjunction retrieval finds a middle-corpus answer among single-term distractors', () => {
  const memory = new SqliteMemory(':memory:');
  try {
    for (let i = 0; i < 20; i++) {
      memory.ingest(`Alpha catalogue early record ${i}.`, `early-alpha/${i}`);
      memory.ingest(`Beta catalogue early record ${i}.`, `early-beta/${i}`);
    }
    memory.ingest('Alpha beta jointly identify the middle evidence.', 'joint-answer');
    for (let i = 0; i < 20; i++) {
      memory.ingest(`Alpha catalogue late record ${i}.`, `late-alpha/${i}`);
      memory.ingest(`Beta catalogue late record ${i}.`, `late-beta/${i}`);
    }
    assert.equal(memory.search('Alpha beta', 1)[0]?.source, 'joint-answer');
  } finally { memory.close(); }
});

test('chunking stays bounded and preserves indentation, ordering, Unicode and normalized line endings', () => {
  const memory = new SqliteMemory(':memory:', { chunkChars: 128 });
  try {
    const text = '    def investigate():\r\n        marker = "café 🛰️"\r\n' + '        print(marker)\r\n'.repeat(20);
    memory.ingest(text, 'code.py');
    const hits = memory.search('marker', 24).sort((a, b) => a.ordinal - b.ordinal);
    assert.ok(hits.length > 1);
    assert.ok(hits[0]!.text.startsWith('    def investigate():\n        marker'));
    assert.ok(hits.every(hit => hit.text.length <= 128 && !hit.text.includes('\r')));
    assert.ok(hits.every(hit => !/[\ud800-\udbff]$/.test(hit.text)));
    const stats = memory.stats();
    assert.ok(stats.estimatedTokens > 0 && stats.estimatedTokens <= stats.bytes);
  } finally { memory.close(); }
});

test('literalized hostile FTS input cannot inject SQL or cause syntax errors', () => {
  const memory = new SqliteMemory(':memory:');
  try {
    memory.ingest('Alpha beta gamma café 中文证据 καφές.', 'reference');
    const hostileQueries = ['" OR *', 'NEAR(alpha beta, 10)', 'alpha) OR (beta', '"; DROP TABLE chunks; --', 'text:alpha NOT beta', '{alpha beta}:*', '\u0000 alpha', '😀 !!!', 'café', '中文证据', 'καφές'];
    for (const query of hostileQueries) {
      assert.doesNotThrow(() => memory.search(query, 4), query);
      assert.ok(memory.search(query, 4).length <= 4);
    }
    assert.equal(memory.search('café')[0]?.source, 'reference');
    assert.equal(memory.search('中文证据')[0]?.source, 'reference');
    assert.equal(memory.search('καφές')[0]?.source, 'reference');
    assert.deepEqual(memory.search('*** " () + -'), []);
    assert.equal(memory.stats().chunks, 1);
  } finally { memory.close(); }
});

test('canonically equivalent Unicode text and queries deduplicate and retrieve consistently', () => {
  const memory = new SqliteMemory(':memory:');
  try {
    const text = 'καφές café evidence';
    assert.deepEqual(memory.ingest(text.normalize('NFD'), 'decomposed'), { inserted: 1, duplicates: 0 });
    assert.deepEqual(memory.ingest(text.normalize('NFC'), 'composed'), { inserted: 0, duplicates: 1 });
    for (const query of ['καφές', 'καφές'.normalize('NFD'), 'café', 'café'.normalize('NFD')]) {
      const hits = memory.search(query);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.text, text.normalize('NFC'));
    }
  } finally { memory.close(); }
});

test('query size, term count, result limits and ingestion inputs remain bounded', () => {
  const memory = new SqliteMemory(':memory:', { maxIngestBytes: 1024 });
  try {
    for (let i = 0; i < 40; i++) memory.ingest(`Common evidence record ${i}.`, `record/${i}`);
    assert.equal(memory.search('Common', 100000).length, 16);
    for (const limit of [-1, 0, NaN, Infinity, -Infinity, 0.5]) assert.deepEqual(memory.search('Common', limit), []);
    assert.equal(memory.search('Common', 2.8).length, 2);
    assert.deepEqual(memory.search(`${' '.repeat(4096)}Common`), []);
    assert.deepEqual(memory.search('one two three four five six seven eight nine ten eleven twelve Common'), []);
    const before = memory.stats();
    assert.throws(() => memory.ingest('🪐'.repeat(300), 'oversized'), /exceeds/);
    assert.throws(() => memory.ingest('text', ''), /source/);
    assert.throws(() => memory.ingest('text', 'x'.repeat(2049)), /source/);
    assert.deepEqual(memory.stats(), before);
  } finally { memory.close(); }
});

test('atomic ingestion rolls back old-source replacement, dedupe, provenance and stats on a SQLite failure', () => {
  const fixture = diskFixture();
  const memory = new SqliteMemory(fixture.path);
  try {
    memory.ingest('Persistent orchid reference.', 'notes');
    const before = memory.stats();
    const db = new DatabaseSync(fixture.path);
    try {
      db.exec("CREATE TRIGGER test_injected_failure BEFORE INSERT ON chunks WHEN new.text LIKE '%FAIL%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    } finally { db.close(); }
    assert.throws(() => memory.ingest('FAIL this replacement.', 'notes'), /injected failure/);
    assert.throws(() => memory.ingest('FAIL a new source.', 'new'), /injected failure/);
    assert.deepEqual(memory.stats(), before);
    assert.equal(memory.search('orchid')[0]?.source, 'notes');
    assert.deepEqual(memory.search('replacement'), []);
  } finally { memory.close(); fixture.cleanup(); }
});

test('disk reopen preserves ranking, provenance, stats and exact content hashes', () => {
  const fixture = diskFixture();
  let memory = new SqliteMemory(fixture.path);
  try {
    memory.ingest('Nimbus forecast predicts frost tonight.', 'weather');
    memory.ingest('Nimbus forecast predicts frost tonight.', 'weather-copy');
    memory.ingest('Nimbus birds migrated before winter.', 'nature');
    const hits = memory.search('Nimbus forecast frost', 3);
    const stats = memory.stats();
    memory.close();
    memory = new SqliteMemory(fixture.path);
    assert.deepEqual(memory.search('Nimbus forecast frost', 3), hits);
    assert.deepEqual(memory.stats(), stats);
    assert.equal(memory.provenance(hits[0]!.id).length, 2);
    assert.deepEqual(memory.ingest('Nimbus forecast predicts frost tonight.', 'weather'), { inserted: 0, duplicates: 1 });
  } finally { memory.close(); fixture.cleanup(); }
});

test('empty memory and closed stores fail predictably; options are validated', () => {
  const memory = new SqliteMemory(':memory:');
  assert.deepEqual(memory.search('anything'), []);
  assert.deepEqual(memory.ingest(' \t\n ', 'blank'), { inserted: 0, duplicates: 0 });
  assert.deepEqual(memory.stats(), { chunks: 0, sources: 0, bytes: 0, estimatedTokens: 0 });
  memory.close();
  memory.close();
  assert.throws(() => memory.search('anything'), /closed/);
  assert.throws(() => memory.ingest('anything', 'source'), /closed/);
  assert.throws(() => memory.stats(), /closed/);
  assert.throws(() => new SqliteMemory(':memory:', { chunkChars: 127 }), /chunkChars/);
  assert.throws(() => new SqliteMemory(':memory:', { maxIngestBytes: Infinity }), /maxIngestBytes/);
});
