import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, StoredSession } from './types.js';

export class SessionStore {
  readonly directory: string;
  constructor(dataDir: string) { this.directory = path.join(dataDir, 'sessions'); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
  create(): StoredSession {
    const now = new Date().toISOString();
    const session = { id: randomUUID(), title: 'New session', createdAt: now, updatedAt: now, messages: [] };
    this.save(session); return session;
  }
  save(session: StoredSession): void {
    if (!/^[a-f0-9-]{36}$/.test(session.id)) throw new Error('Invalid session ID.');
    session.updatedAt = new Date().toISOString();
    // Persist recent complete user turns; older text lives separately in the archive.
    while (session.messages.length > 200 || Buffer.byteLength(JSON.stringify(session.messages)) > 1024 * 1024) {
      const nextTurn = session.messages.findIndex((m, i) => i > 0 && m.role === 'user');
      if (nextTurn < 0) throw new Error('Session turn exceeds the local storage limit.');
      session.messages.splice(0, nextTurn);
    }
    const target = path.join(this.directory, `${session.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(session, null, 2), { mode: 0o600 });
    renameSync(temporary, target);
  }
  load(id: string): StoredSession {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Use a full session ID from /sessions.');
    const filename = path.join(this.directory, `${id}.json`);
    if (lstatSync(filename).isSymbolicLink() || lstatSync(filename).nlink > 1) throw new Error('Linked session files are blocked.');
    if (statSync(filename).size > 2 * 1024 * 1024) throw new Error('Session file exceeds the local limit.');
    const parsed: unknown = JSON.parse(readFileSync(filename, 'utf8'));
    if (!validSession(parsed) || parsed.id !== id) throw new Error('Invalid session data.');
    return parsed;
  }
  list(): Array<Pick<StoredSession, 'id' | 'title' | 'updatedAt'>> {
    return readdirSync(this.directory).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).slice(-1000).flatMap(file => {
      try { const session = this.load(file.slice(0, -5)); return [{ id: session.id, title: session.title, updatedAt: session.updatedAt }]; } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  }
}
function validMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const m = value as Message;
  if (!['user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string') return false;
  if (m.tool_call_id !== undefined && typeof m.tool_call_id !== 'string') return false;
  return m.tool_calls === undefined || (Array.isArray(m.tool_calls) && m.tool_calls.length <= 8 && m.tool_calls.every(t => typeof t.id === 'string' && typeof t.name === 'string' && typeof t.arguments === 'string'));
}
function validSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as StoredSession;
  return typeof s.id === 'string' && typeof s.title === 'string' && typeof s.createdAt === 'string' && typeof s.updatedAt === 'string' && Array.isArray(s.messages) && s.messages.length <= 200 && s.messages.every(validMessage);
}
