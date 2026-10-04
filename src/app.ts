import { mkdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfirmWrite, HarnessEvent, StoredSession, SunConfig, TurnResult } from './types.js';
import { presetFor } from './config.js';
import { SqliteMemory } from './memory.js';
import { SessionStore } from './sessions.js';
import { createProvider } from './provider.js';
import { createTools, readWorkspaceFile } from './tools.js';
import { buildContext, Harness, InterruptedTurn } from './harness.js';
import { TOOL_DEFINITIONS } from './tools.js';

export const COMMAND_HELP = `Send a message to start a task. Streams can be cancelled with Ctrl+C.
/task <goal>       bounded model/tool loop (same loop as ordinary chat)
/status            model evidence, active budget and external corpus statistics
/model [preset]    list/select speedx27, speedx2, custom
/tools [on|off]    opt in to backend structured tools; writes still need approval
/ingest <file>     index one UTF-8 text file inside the workspace (up to 8 MiB)
/memory <query>    preview indexed evidence with provenance
/new               start a fresh session (external memory persists)
/sessions          list recent saved session IDs
/resume <id>       load a saved session
/help /quit        help or exit
Use a trailing backslash for multiline messages.
The 1T logical corpus target is untested; model context stays bounded.`;

export class SunApp {
  readonly memory: SqliteMemory;
  readonly sessions: SessionStore;
  private current: StoredSession;
  private confirm: ConfirmWrite = async () => false;
  constructor(readonly config: SunConfig) {
    if (existsSync(config.dataDir) && lstatSync(config.dataDir).isSymbolicLink()) throw new Error('.sun must be a local directory, not a symbolic link.');
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    if (path.dirname(realpathSync(config.dataDir)) !== realpathSync(config.workspace)) throw new Error('Data directory must be directly inside the workspace.');
    const memoryPath = path.join(config.dataDir, 'memory.sqlite');
    for (const candidate of [memoryPath, `${memoryPath}-wal`, `${memoryPath}-shm`, path.join(config.dataDir, 'sessions')]) {
      if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new Error('SUN data files cannot be symbolic links.');
    }
    this.memory = new SqliteMemory(memoryPath);
    this.sessions = new SessionStore(config.dataDir);
    this.current = this.sessions.create();
  }
  session(): StoredSession { return this.current; }
  memoryStats() { return this.memory.stats(); }
  setConfirm(callback: ConfirmWrite): void { this.confirm = callback; }
  close(): void { this.memory.close(); }
  async submit(text: string, onEvent: (event: HarnessEvent) => void, signal: AbortSignal): Promise<TurnResult> {
    const task = text.startsWith('/task ') ? text.slice(6).trim() : text;
    if (this.current.title === 'New session') this.current.title = task.slice(0, 70).replace(/\s+/g, ' ');
    const harness = new Harness(this.config, createProvider(this.config), this.memory, createTools(this.config.workspace, this.memory, this.confirm));
    try {
      const result = await harness.run(task, this.current.messages, onEvent, signal);
      this.current.messages.push(...result.messages);
      // Preserve durable passages independently of the bounded working transcript.
      this.memory.ingest(result.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `[${m.role}] ${m.content}`).join('\n\n'), `session:${this.current.id}/turn:${randomUUID()}`);
      return result;
    } catch (error) {
      if (error instanceof InterruptedTurn) this.current.messages.push(...error.messages);
      throw error;
    } finally { this.sessions.save(this.current); }
  }
  async command(line: string): Promise<string> {
    const split = line.trim().indexOf(' ');
    const command = split < 0 ? line.trim() : line.trim().slice(0, split);
    const argument = split < 0 ? '' : line.trim().slice(split + 1).trim();
    switch (command) {
      case '/help': return COMMAND_HELP;
      case '/status': case '/stats': {
        const stats = this.memory.stats();
        return `${this.config.demo ? 'Offline demo' : 'OpenAI-compatible streaming connection'}\nModel: ${this.config.model}\nPreset cap: ${this.config.preset.contextLimit ?? 'unknown'} tokens\nEvidence: ${this.config.preset.contextEvidence}\nActive budget: ${this.config.contextTokens} tokens total; output reserved: ${this.config.outputTokens}\nInput estimation: UTF-8 bytes + framing margin; conservative proxy, not exact tokenizer\nExternal corpus: ${stats.chunks} unique chunks / ${stats.sources} sources / ${stats.bytes} payload bytes / ~${stats.estimatedTokens} tokens (bytes/4 estimate)\nLogical target: 1,000,000,000,000 tokens · UNTESTED\nTools: ${this.config.toolsEnabled ? 'opted in' : 'disabled'} · step cap ${this.config.maxSteps}\nSession: ${this.current.id}\nWorkspace: ${this.config.workspace}`;
      }
      case '/model': {
        if (!argument) return 'speedx27 · 27B custom VL architecture (text interface here), publisher boundary 262144\nspeedx2 · 2B text model, conservative benchmark cap 16384\ncustom · model/served context must be verified by the operator\nCurrent: ' + this.config.preset.id;
        const preset = presetFor(argument);
        this.config.preset = preset;
        this.config.model = preset.model;
        this.config.contextTokens = Math.min(this.config.contextTokens, preset.contextLimit ?? 262144);
        this.config.outputTokens = Math.min(this.config.outputTokens, Math.floor(this.config.contextTokens / 2));
        this.config.toolsEnabled = false;
        return `Selected ${preset.id}: ${preset.model}. Tools disabled until backend support is confirmed with /tools on. ${preset.contextEvidence}`;
      }
      case '/tools':
        if (!argument) return `Tools ${this.config.toolsEnabled ? 'enabled' : 'disabled'}. /tools on opts into structured API tool calls; your server must support them.`;
        if (!['on', 'off'].includes(argument)) throw new Error('Use /tools on or /tools off.');
        if (argument === 'on') buildContext([], [{ role: 'user', content: 'Minimum task' }], [], this.config, TOOL_DEFINITIONS);
        this.config.toolsEnabled = argument === 'on';
        return `Tools ${argument}. ${argument === 'on' ? 'Backend compatibility is operator asserted; every file write requires separate approval.' : ''}`;
      case '/ingest': {
        if (!argument) throw new Error('Use /ingest relative/path.txt inside the workspace.');
        const file = unquote(argument);
        const text = await readWorkspaceFile(this.config.workspace, file, 8 * 1024 * 1024);
        if (text.includes('\u0000')) throw new Error('Ingest accepts text, not binary files.');
        const source = path.relative(this.config.workspace, path.resolve(this.config.workspace, file)).replaceAll('\\', '/');
        const result = this.memory.ingest(text, `file:${source}`);
        return `Indexed ${source}: ${result.inserted} new chunks; ${result.duplicates} deduplicated. Source snapshots replace older versions.`;
      }
      case '/memory': {
        if (!argument) throw new Error('Use /memory <query>.');
        const hits = this.memory.search(argument, 6);
        return hits.length ? hits.map(h => `[memory:${h.id}] ${h.source}\n${h.text.slice(0, 900)}`).join('\n\n') : 'No matching external evidence.';
      }
      case '/new': this.current = this.sessions.create(); return `New session ${this.current.id}. External memory persists.`;
      case '/sessions': return this.sessions.list().map(s => `${s.id}  ${s.updatedAt.slice(0, 16)}  ${s.title}`).join('\n') || 'No sessions.';
      case '/resume': this.current = this.sessions.load(argument); return `Resumed ${this.current.id}: ${this.current.title}`;
      default: throw new Error('Unknown command. Use /help.');
    }
  }
}
function unquote(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}
