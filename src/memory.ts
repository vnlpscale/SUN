import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Memory, MemoryHit, MemoryStats } from './types.js';

const MAX_INGEST_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_CHARS = 4096;
const MAX_QUERY_TERMS = 12;
const CANDIDATES_PER_DIRECTION = 8;
const MAX_RESULTS = 24;
const MAX_VISIBLE_SOURCES = 8;

export interface MemoryOptions {
  /** Chunk size in UTF-16 characters, bounded to 128..8192. */
  chunkChars?: number;
  /** A lower per-ingestion limit may be used; the hard maximum is 8 MiB. */
  maxIngestBytes?: number;
}

export interface ChunkProvenance { source: string; ordinal: number }

interface Candidate {
  rowid: number;
  id: string;
  text: string;
  matchedTerms: Set<string>;
  rank: number;
  features: Set<string>;
  provenance: ChunkProvenance[];
  extraSources: boolean;
  relevance: number;
}

function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function canonical(text: string): string { return text.replace(/\r\n?/g, '\n').normalize('NFC'); }
function fold(text: string): string { return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''); }

function lexicalTerms(text: string, limit: number): string[] {
  const terms = new Set<string>();
  for (const match of text.normalize('NFC').matchAll(/[\p{L}\p{N}]+/gu)) {
    // Long identifiers have little retrieval value and increase FTS expression size.
    if (match[0].length > 128) continue;
    // Keep accents in MATCH tokens: unicode61 removes Latin diacritics but not all scripts.
    terms.add(match[0].toLowerCase().normalize('NFC'));
    if (terms.size >= limit) break;
  }
  return [...terms];
}

function* chunks(text: string, size: number): Generator<string> {
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + size, text.length);
    if (end < text.length) {
      // Prefer a line/word boundary without allowing unusually long lines to grow a chunk.
      const window = text.slice(offset, end);
      const boundary = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '), window.lastIndexOf('\t'));
      if (boundary >= Math.floor(size * 0.6)) end = offset + boundary + 1;
      // Never split a UTF-16 surrogate pair.
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    const chunk = text.slice(offset, end);
    if (chunk.trim()) yield chunk;
    offset = end;
  }
}

function similarity(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const term of a) if (b.has(term)) common++;
  return common / Math.max(1, a.size + b.size - common);
}

/**
 * Persistent, lexical external memory. Each source is a replaceable snapshot;
 * content hashes deduplicate storage while provenance retains every occurrence.
 *
 * FTS posting lists produce at most 208 candidates: 12 literal terms plus their
 * conjunction, each with 8 oldest + 8 newest matches.
 * Ranking and diversity operate only on that shortlist. This bounds JavaScript
 * work and result memory, not SQLite latency on an untested enormous corpus.
 * The diversity heuristic is inspired by separating reusable content from local
 * transitions; it does not implement SinkRec RVQ, TDGD, or model training.
 */
export class SqliteMemory implements Memory {
  private readonly db: DatabaseSync;
  private readonly chunkChars: number;
  private readonly maxIngestBytes: number;
  private readonly lookupSource: StatementSync;
  private readonly insertChunk: StatementSync;
  private readonly lookupChunk: StatementSync;
  private readonly insertProvenance: StatementSync;
  private readonly insertChunkSource: StatementSync;
  private readonly oldestMatches: StatementSync;
  private readonly newestMatches: StatementSync;
  private readonly readProvenance: StatementSync;
  private closed = false;

  constructor(path: string, options: MemoryOptions = {}) {
    this.chunkChars = options.chunkChars ?? 4096;
    this.maxIngestBytes = options.maxIngestBytes ?? MAX_INGEST_BYTES;
    if (!Number.isInteger(this.chunkChars) || this.chunkChars < 128 || this.chunkChars > 8192) {
      throw new Error('Memory chunkChars must be an integer from 128 to 8192.');
    }
    if (!Number.isInteger(this.maxIngestBytes) || this.maxIngestBytes < 1 || this.maxIngestBytes > MAX_INGEST_BYTES) {
      throw new Error('Memory maxIngestBytes must be an integer from 1 to 8388608.');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { allowExtension: false, enableDoubleQuotedStringLiterals: false });
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (version > 1) throw new Error(`Memory database schema ${version} is newer than supported schema 1.`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_totals (
          id INTEGER PRIMARY KEY CHECK (id = 1), chunks INTEGER NOT NULL,
          sources INTEGER NOT NULL, bytes INTEGER NOT NULL, estimated_tokens INTEGER NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO memory_totals VALUES (1, 0, 0, 0, 0);
        CREATE TABLE IF NOT EXISTS chunks (
          rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
          bytes INTEGER NOT NULL, estimated_tokens INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS sources (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
          fingerprint TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE TABLE IF NOT EXISTS provenance (
          chunk_rowid INTEGER NOT NULL REFERENCES chunks(rowid) ON DELETE CASCADE,
          source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          PRIMARY KEY (source_id, ordinal, chunk_rowid)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS provenance_by_chunk ON provenance(chunk_rowid, source_id, ordinal);
        CREATE TABLE IF NOT EXISTS chunk_sources (
          chunk_rowid INTEGER NOT NULL REFERENCES chunks(rowid) ON DELETE CASCADE,
          source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          first_ordinal INTEGER NOT NULL, PRIMARY KEY (chunk_rowid, source_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS chunk_sources_by_source ON chunk_sources(source_id, chunk_rowid);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text, content='chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
          UPDATE memory_totals SET chunks = chunks + 1, bytes = bytes + new.bytes,
            estimated_tokens = estimated_tokens + new.estimated_tokens WHERE id = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          UPDATE memory_totals SET chunks = chunks - 1, bytes = bytes - old.bytes,
            estimated_tokens = estimated_tokens - old.estimated_tokens WHERE id = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS sources_insert AFTER INSERT ON sources BEGIN
          UPDATE memory_totals SET sources = sources + 1 WHERE id = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS sources_delete AFTER DELETE ON sources BEGIN
          UPDATE memory_totals SET sources = sources - 1 WHERE id = 1;
        END;
        CREATE TEMP TABLE previous_source_chunks (chunk_rowid INTEGER PRIMARY KEY);
        PRAGMA user_version = 1;
      `);
      this.lookupSource = this.db.prepare('SELECT id, fingerprint, chunk_count FROM sources WHERE name = ?');
      this.insertChunk = this.db.prepare('INSERT OR IGNORE INTO chunks(id, text, bytes, estimated_tokens) VALUES (?, ?, ?, ?)');
      this.lookupChunk = this.db.prepare('SELECT rowid FROM chunks WHERE id = ?');
      this.insertProvenance = this.db.prepare('INSERT OR IGNORE INTO provenance(chunk_rowid, source_id, ordinal) VALUES (?, ?, ?)');
      this.insertChunkSource = this.db.prepare('INSERT OR IGNORE INTO chunk_sources(chunk_rowid, source_id, first_ordinal) VALUES (?, ?, ?)');
      // Avoid ORDER BY bm25 over every matching document. Rowid order is served by FTS5.
      this.oldestMatches = this.db.prepare(`
        SELECT c.rowid, c.id, c.text, bm25(chunks_fts) AS rank FROM chunks_fts
        JOIN chunks c ON c.rowid = chunks_fts.rowid WHERE chunks_fts MATCH ?
        ORDER BY chunks_fts.rowid ASC LIMIT ?
      `);
      this.newestMatches = this.db.prepare(`
        SELECT c.rowid, c.id, c.text, bm25(chunks_fts) AS rank FROM chunks_fts
        JOIN chunks c ON c.rowid = chunks_fts.rowid WHERE chunks_fts MATCH ?
        ORDER BY chunks_fts.rowid DESC LIMIT ?
      `);
      // Precomputed source summaries keep repeated positions from expanding a recall query.
      this.readProvenance = this.db.prepare(`
        SELECT s.name AS source, p.first_ordinal AS ordinal FROM chunk_sources p
        JOIN sources s ON s.id = p.source_id WHERE p.chunk_rowid = ?
        ORDER BY p.source_id LIMIT ?
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private ensureOpen(): void { if (this.closed) throw new Error('Memory is closed.'); }

  ingest(text: string, source: string): { inserted: number; duplicates: number } {
    this.ensureOpen();
    if (typeof text !== 'string' || typeof source !== 'string') throw new Error('Memory text and source must be strings.');
    if (Buffer.byteLength(text, 'utf8') > this.maxIngestBytes) throw new Error(`Memory ingestion exceeds ${this.maxIngestBytes} bytes.`);
    const sourceName = source.trim();
    if (!sourceName || Buffer.byteLength(sourceName, 'utf8') > 2048) throw new Error('Memory source must contain 1..2048 UTF-8 bytes.');
    const normalized = canonical(text);
    const fingerprint = hash(`${this.chunkChars}\n${normalized}`);
    let inserted = 0;
    let duplicates = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.lookupSource.get(sourceName);
      if (existing?.fingerprint === fingerprint) {
        this.db.exec('COMMIT');
        return { inserted: 0, duplicates: Number(existing.chunk_count) };
      }
      let sourceId: number;
      this.db.exec('DELETE FROM previous_source_chunks');
      if (existing) {
        sourceId = Number(existing.id);
        this.db.prepare('INSERT OR IGNORE INTO previous_source_chunks SELECT chunk_rowid FROM provenance WHERE source_id = ?').run(sourceId);
        this.db.prepare('DELETE FROM provenance WHERE source_id = ?').run(sourceId);
        this.db.prepare('DELETE FROM chunk_sources WHERE source_id = ?').run(sourceId);
        this.db.prepare('UPDATE sources SET fingerprint = ? WHERE id = ?').run(fingerprint, sourceId);
      } else {
        const result = this.db.prepare('INSERT INTO sources(name, fingerprint) VALUES (?, ?)').run(sourceName, fingerprint);
        sourceId = Number(result.lastInsertRowid);
      }
      let ordinal = 0;
      for (const textChunk of chunks(normalized, this.chunkChars)) {
        const id = hash(textChunk);
        const bytes = Buffer.byteLength(textChunk, 'utf8');
        const result = this.insertChunk.run(id, textChunk, bytes, Math.ceil(bytes / 4));
        if (Number(result.changes) === 1) inserted++; else duplicates++;
        const chunkRow = this.lookupChunk.get(id);
        if (!chunkRow) throw new Error('Could not locate inserted memory chunk.');
        this.insertProvenance.run(Number(chunkRow.rowid), sourceId, ordinal);
        this.insertChunkSource.run(Number(chunkRow.rowid), sourceId, ordinal++);
      }
      this.db.prepare('UPDATE sources SET chunk_count = ? WHERE id = ?').run(ordinal, sourceId);
      this.db.exec(`
        DELETE FROM chunks WHERE rowid IN (SELECT chunk_rowid FROM previous_source_chunks)
          AND NOT EXISTS (SELECT 1 FROM provenance WHERE provenance.chunk_rowid = chunks.rowid);
        DELETE FROM previous_source_chunks;
      `);
      if (!ordinal) this.db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
      this.db.exec('COMMIT');
      return { inserted, duplicates };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  search(query: string, limit = 6): MemoryHit[] {
    this.ensureOpen();
    if (typeof query !== 'string' || !Number.isFinite(limit) || limit <= 0) return [];
    const resultLimit = Math.min(MAX_RESULTS, Math.floor(limit));
    if (!resultLimit) return [];
    const terms = lexicalTerms(query.slice(0, MAX_QUERY_CHARS), MAX_QUERY_TERMS);
    if (!terms.length) return [];
    this.db.exec('BEGIN');
    try {
      const hits = this.searchTerms(terms, resultLimit);
      this.db.exec('COMMIT');
      return hits;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private searchTerms(terms: string[], resultLimit: number): MemoryHit[] {
    const candidates = new Map<number, Candidate>();
    const collect = (expression: string, matchedTerms: string[]): void => {
      for (const statement of [this.oldestMatches, this.newestMatches]) {
        for (const row of statement.all(expression, CANDIDATES_PER_DIRECTION)) {
          const rowid = Number(row.rowid);
          let candidate = candidates.get(rowid);
          if (!candidate) {
            candidate = {
              rowid, id: String(row.id), text: String(row.text), matchedTerms: new Set(),
              rank: 0, features: new Set(), provenance: [], extraSources: false, relevance: 0,
            };
            candidates.set(rowid, candidate);
          }
          if (matchedTerms.some(term => !candidate.matchedTerms.has(term))) candidate.rank += Math.max(0, -Number(row.rank));
          for (const term of matchedTerms) candidate.matchedTerms.add(term);
        }
      }
    };
    // Retrieve conjunctions first so a middle-corpus answer is not hidden by common single terms.
    // Only bounded literal tokens enter MATCH; user-provided FTS operators never do.
    if (terms.length > 1) collect(terms.map(term => `"${term}"`).join(' AND '), terms);
    for (const term of terms) collect(`"${term}"`, [term]);
    const shortlist = [...candidates.values()];
    const maxRank = Math.max(1e-12, ...shortlist.map(candidate => candidate.rank));
    for (const candidate of shortlist) {
      candidate.features = new Set(lexicalTerms(candidate.text, 512).map(fold));
      const provenance = this.readProvenance.all(candidate.rowid, MAX_VISIBLE_SOURCES + 1);
      candidate.extraSources = provenance.length > MAX_VISIBLE_SOURCES;
      candidate.provenance = provenance.slice(0, MAX_VISIBLE_SOURCES).map(row => ({ source: String(row.source), ordinal: Number(row.ordinal) }));
      candidate.relevance = 0.8 * candidate.matchedTerms.size / terms.length + 0.2 * candidate.rank / maxRank;
    }
    const selected: Candidate[] = [];
    const remaining = new Set(shortlist);
    while (selected.length < resultLimit && remaining.size) {
      let best: Candidate | undefined;
      let bestUtility = -Infinity;
      for (const candidate of remaining) {
        let redundancy = 0;
        let sameSource = 0;
        let adjacent = 0;
        for (const prior of selected) {
          redundancy = Math.max(redundancy, similarity(candidate.features, prior.features));
          const left = candidate.provenance[0];
          const right = prior.provenance[0];
          if (left && right && left.source === right.source) {
            sameSource++;
            if (Math.abs(left.ordinal - right.ordinal) <= 1) adjacent = 1;
          }
        }
        const utility = candidate.relevance - 0.45 * redundancy - 0.08 * sameSource - 0.04 * adjacent;
        if (utility > bestUtility || (utility === bestUtility && candidate.rowid < (best?.rowid ?? Infinity))) {
          best = candidate;
          bestUtility = utility;
        }
      }
      if (!best) break;
      selected.push(best);
      remaining.delete(best);
    }
    return selected.map(candidate => ({
      id: candidate.id,
      source: candidate.provenance.map(entry => entry.source).join(' | ') + (candidate.extraSources ? ' | …more sources' : ''),
      text: candidate.text,
      score: candidate.relevance,
      ordinal: candidate.provenance[0]?.ordinal ?? 0,
    }));
  }

  /** Paginated exact provenance, including repeated positions within a source. */
  provenance(id: string, limit = 128, offset = 0): ChunkProvenance[] {
    this.ensureOpen();
    if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit <= 0 || offset < 0) return [];
    return this.db.prepare(`
      SELECT s.name AS source, p.ordinal FROM chunks c
      JOIN provenance p ON p.chunk_rowid = c.rowid JOIN sources s ON s.id = p.source_id
      WHERE c.id = ? ORDER BY p.source_id, p.ordinal LIMIT ? OFFSET ?
    `).all(id, Math.min(128, Math.floor(limit)), Math.floor(offset))
      .map(row => ({ source: String(row.source), ordinal: Number(row.ordinal) }));
  }

  stats(): MemoryStats {
    this.ensureOpen();
    const row = this.db.prepare('SELECT chunks, sources, bytes, estimated_tokens FROM memory_totals WHERE id = 1').get();
    return { chunks: Number(row?.chunks ?? 0), sources: Number(row?.sources ?? 0), bytes: Number(row?.bytes ?? 0), estimatedTokens: Number(row?.estimated_tokens ?? 0) };
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
