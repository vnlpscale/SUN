import * as readline from 'node:readline';
import type { Key } from 'node:readline';
import type { ConfirmWrite, HarnessEvent, MemoryStats, StoredSession, SunConfig, TurnResult } from './types.js';
import { safeTerminalText, StreamTextFilter } from './terminal.js';

export interface TuiController {
  config: SunConfig;
  session(): StoredSession;
  memoryStats(): MemoryStats;
  submit(text: string, onEvent: (event: HarnessEvent) => void, signal: AbortSignal): Promise<TurnResult>;
  command(line: string): Promise<string>;
  setConfirm(callback: ConfirmWrite): void;
}

/** Render data as text, never as terminal instructions (including OSC hyperlinks). */
export function sanitizeTerminalText(value: string): string {
  return safeTerminalText(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

const count = (value: number): string => Number.isFinite(value) ? Math.max(0, Math.round(value)).toLocaleString('en-US') : '?';
const scalarWidth = (character: string): number => {
  if (/\p{Mark}/u.test(character)) return 0;
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) || code >= 0x20000) ? 2 : 1;
};
const width = (value: string): number => Array.from(value).reduce((total, character) => total + scalarWidth(character), 0);
function wrap(value: string, columns: number): string[] {
  const result: string[] = [];
  for (const logicalLine of value.split('\n')) {
    let line = '';
    for (const word of logicalLine.split(/\s+/u)) {
      if (line && width(line + ' ' + word) > columns) { result.push(line); line = ''; }
      if (width(word) <= columns) line += (line ? ' ' : '') + word;
      else {
        // Long model identifiers still fit in narrow terminals without overflowing the border.
        for (const character of word) {
          if (line && width(line + character) > columns) { result.push(line); line = ''; }
          line += character;
        }
      }
    }
    result.push(line);
  }
  return result;
}

type PendingLine = { prompt: string; history: boolean; resolve: (value: string | null) => void };

/** One input owner: ordinary input is locked while a turn or command is running. */
class TerminalInput {
  private readonly rl?: readline.Interface;
  private pending?: PendingLine;
  private readonly queued: string[] = [];
  private readonly history: string[] = [];
  private buffer: string[] = [];
  private cursor = 0;
  private historyIndex = 0;
  private historyDraft = '';
  private ended = false;
  private closed = false;
  private cancelledInput = false;
  private readonly oldRawMode: boolean;
  private readonly keyHandler = (value: string, key: Key): void => this.key(value, key);
  private readonly resizeHandler = (): void => this.draw();
  private readonly signalHandler = (): void => this.interrupt();

  constructor(
    private readonly interactive: boolean,
    private readonly clean: (value: string) => string,
    private readonly accent: (value: string) => string,
    private readonly onInterrupt: () => void,
    private readonly onExit: () => void,
  ) {
    this.oldRawMode = process.stdin.isRaw ?? false;
    if (interactive) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on('keypress', this.keyHandler);
      process.stdout.on('resize', this.resizeHandler);
      process.stdin.resume();
    } else {
      this.rl = readline.createInterface({ input: process.stdin, terminal: false });
      this.rl.on('line', (line: string) => {
        if (this.pending) this.resolve(line);
        else this.queued.push(line);
      });
      this.rl.on('close', () => { this.ended = true; if (this.pending) this.resolve(null); });
    }
    process.on('SIGINT', this.signalHandler);
  }

  ask(prompt: string, history = false): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.pending) throw new Error('Terminal input already has a pending question.');
    this.buffer = [];
    this.cursor = 0;
    this.historyIndex = this.history.length;
    this.historyDraft = '';
    this.cancelledInput = false;
    return new Promise((resolve) => {
      this.pending = { prompt, history, resolve };
      if (this.interactive) this.draw();
      else {
        process.stdout.write(prompt);
        const queued = this.queued.shift();
        if (queued !== undefined) this.resolve(queued);
        else if (this.ended) this.resolve(null);
      }
    });
  }

  consumeCancellation(): boolean {
    const cancelled = this.cancelledInput;
    this.cancelledInput = false;
    return cancelled;
  }

  async approvalBoundary(): Promise<void> {
    // Let already-buffered keypress events be discarded while no question owns input.
    this.buffer = [];
    this.cursor = 0;
    if (this.interactive) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) this.resolve(null);
    process.off('SIGINT', this.signalHandler);
    if (this.interactive) {
      process.stdin.off('keypress', this.keyHandler);
      process.stdout.off('resize', this.resizeHandler);
      process.stdin.setRawMode(this.oldRawMode);
      process.stdin.pause();
    } else this.rl?.close();
  }

  private resolve(value: string | null): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (this.interactive) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(this.accent(pending.prompt) + this.clean(value ?? '') + '\n');
    } else process.stdout.write(this.clean(value ?? '') + '\n');
    if (pending.history && value?.trim() && this.history.at(-1) !== value) {
      this.history.push(value);
      if (this.history.length > 200) this.history.shift();
    }
    this.buffer = [];
    this.cursor = 0;
    pending.resolve(value);
  }

  private interrupt(): void {
    if (this.pending) { this.cancelledInput = true; this.resolve(''); }
    this.onInterrupt();
  }

  private key(value: string, key: Key): void {
    if (key.ctrl && key.name === 'c') { this.interrupt(); return; }
    if (key.ctrl && key.name === 'd') { this.onExit(); this.close(); return; }
    // No echo or queued submissions during a running turn. Confirmations own this same editor.
    if (!this.pending) return;
    if (key.name === 'return' || key.name === 'enter') { this.resolve(this.buffer.join('')); return; }
    if (key.name === 'backspace') {
      if (this.cursor > 0) { this.buffer.splice(--this.cursor, 1); }
    } else if (key.name === 'delete') this.buffer.splice(this.cursor, 1);
    else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(this.buffer.length, this.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) this.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) this.cursor = this.buffer.length;
    else if (key.ctrl && key.name === 'u') { this.buffer.splice(0, this.cursor); this.cursor = 0; }
    else if (key.ctrl && key.name === 'k') this.buffer.splice(this.cursor);
    else if (key.ctrl && key.name === 'w') {
      const before = this.buffer.slice(0, this.cursor).join('');
      const kept = before.replace(/\s*\S+\s*$/, '');
      const start = Array.from(kept).length;
      this.buffer.splice(start, this.cursor - start);
      this.cursor = start;
    } else if ((key.name === 'up' || key.name === 'down') && this.pending.history) {
      if (this.historyIndex === this.history.length) this.historyDraft = this.buffer.join('');
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      this.buffer = Array.from(this.historyIndex === this.history.length ? this.historyDraft : this.history[this.historyIndex] ?? '');
      this.cursor = this.buffer.length;
    } else if (!key.ctrl && !key.meta && value) {
      const characters = Array.from(this.clean(value).replace(/[\n\t]/g, ' '));
      this.buffer.splice(this.cursor, 0, ...characters);
      this.cursor += characters.length;
    } else return;
    this.draw();
  }

  private draw(): void {
    const pending = this.pending;
    if (!pending || !this.interactive) return;
    const promptWidth = width(pending.prompt);
    const available = Math.max(3, (process.stdout.columns || 80) - promptWidth - 1);
    let start = 0;
    while (width(this.buffer.slice(start, this.cursor).join('')) >= available - 1 && start < this.cursor) start++;
    const prefix = start > 0 ? '‹' : '';
    let visible = prefix;
    let end = start;
    while (end < this.buffer.length && width(visible + (this.buffer[end] ?? '')) < available) visible += this.buffer[end++];
    const caret = width(prefix + this.buffer.slice(start, this.cursor).join(''));
    if (end < this.buffer.length && width(visible) < available) visible += '›';
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(this.accent(pending.prompt) + visible);
    readline.cursorTo(process.stdout, Math.min((process.stdout.columns || 80) - 1, promptWidth + caret));
  }
}

class Output {
  private lineOpen = false;
  private inReply = false;
  receivedText = false;
  constructor(private readonly clean: (value: string) => string, private readonly accent: (value: string) => string, private readonly dim: (value: string) => string) {}
  reset(): void { this.receivedText = false; this.inReply = false; }
  finishLine(): void {
    if (this.lineOpen) process.stdout.write('\n');
    this.lineOpen = false;
  }
  delta(value: string): void {
    const text = this.clean(value);
    if (!text) return;
    if (!this.inReply) { this.finishLine(); process.stdout.write('\n' + this.accent('SUN') + this.dim(' · assistant') + '\n'); this.inReply = true; }
    process.stdout.write(text);
    this.lineOpen = !text.endsWith('\n');
    this.receivedText = true;
  }
  note(label: string, value: string): void {
    this.finishLine();
    this.inReply = false;
    process.stdout.write(this.dim('  · ' + label + '  ') + this.clean(value) + '\n');
  }
  text(value: string): void {
    this.finishLine();
    this.inReply = false;
    process.stdout.write(this.clean(value) + '\n');
  }
}

export async function runTui(controller: TuiController): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb');
  const color = interactive && !('NO_COLOR' in process.env);
  const accent = (value: string): string => color ? `\x1b[38;5;214m${value}\x1b[0m` : value;
  const dim = (value: string): string => color ? `\x1b[2m${value}\x1b[0m` : value;
  const clean = (value: string): string => {
    const secret = controller.config.apiKey;
    const sanitized = sanitizeTerminalText(value);
    return secret ? sanitized.split(secret).join('[redacted]') : sanitized;
  };
  const compact = (value: string, limit = 160): string => {
    const text = clean(value).replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  };
  const summarizeTool = (event: Extract<HarnessEvent, { type: 'tool' }>): string => {
    const name = compact(event.name, 60);
    if (event.state === 'requested') return name + ' · checking permission and arguments';
    let result: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(event.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as Record<string, unknown>;
    } catch { /* A bounded excerpt or non-JSON tool result still stays out of the display. */ }
    if (result?.truncated === true) return name + ' · Bounded result excerpt supplied (truncated)';
    if (typeof result?.error === 'string') return name + ' · denied/failed: ' + compact(result.error, 240);
    if (result?.ok === false) return name + ' · denied/failed';
    if (Array.isArray(result?.hits)) return 'Retrieved ' + count(result.hits.length) + ' chunks';
    if (event.name === 'read_file' && typeof result?.path === 'string') return 'Read ' + compact(result.path, 240);
    if (event.name === 'write_file' && typeof result?.path === 'string') return 'Wrote ' + compact(result.path, 240) + (typeof result.bytes === 'number' ? ' · ' + count(result.bytes) + ' bytes' : '');
    return name + ' · result supplied to model';
  };
  const output = new Output(clean, accent, dim);
  let active: AbortController | undefined;
  let exiting = false;
  const input = new TerminalInput(interactive, clean, accent, () => {
    if (active && !active.signal.aborted) {
      active.abort();
      output.note('cancel', 'Stopping the current turn…');
    }
  }, () => { exiting = true; active?.abort(); });

  const header = (): void => {
    const config = controller.config;
    const memory = controller.memoryStats();
    const session = controller.session();
    const columns = Math.max(24, Math.min(112, (process.stdout.columns || 88) - 2));
    const inner = columns - 4;
    const lines = [
      '☀  SUN  /  external-memory AI harness',
      `${config.demo ? 'DEMO · offline' : 'API configured'}  ·  ${config.model}`,
      `Preset cap: ${config.preset.contextLimit === null ? 'unverified' : count(config.preset.contextLimit) + ' tokens'}  ·  Active budget: ${count(config.contextTokens)}  ·  Output: ${count(config.outputTokens)}`,
      `Indexed corpus: ~${count(memory.estimatedTokens)} tokens (estimated)  ·  ${count(memory.chunks)} chunks / ${count(memory.sources)} sources`,
      '1T logical corpus target: experimental and untested; separate from the model window.',
      `Session: ${session.id}  ·  Tools: ${config.toolsEnabled ? 'on · writes require approval' : 'off'}`,
    ];
    if (interactive) {
      process.stdout.write('\n' + accent('┌' + '─'.repeat(columns - 2) + '┐') + '\n');
      for (const line of lines.flatMap(value => wrap(clean(value).replace(/\t/g, ' '), inner))) {
        process.stdout.write(accent('│ ') + line + ' '.repeat(Math.max(0, inner - width(line))) + accent(' │') + '\n');
      }
      process.stdout.write(accent('└' + '─'.repeat(columns - 2) + '┘') + '\n');
    } else process.stdout.write('\n' + lines.map(clean).join('\n') + '\n');
    process.stdout.write(dim('  Ask a question or /task <goal>. /ingest <file> adds searchable memory.') + '\n');
    process.stdout.write(dim('  /help · /status · /memory <query> · /model · /sessions · /quit') + '\n');
    process.stdout.write(dim('  End a line with \\ to continue. ↑/↓ history · Ctrl+C cancel · Ctrl+D exit.') + '\n\n');
  };

  controller.setConfirm(async request => {
    if (exiting || active?.signal.aborted) return false;
    output.finishLine();
    if (!interactive) {
      output.note('write denied', 'Write approval requires an interactive terminal; piped input cannot approve writes.');
      return false;
    }
    const secret = controller.config.apiKey;
    if (secret && (request.content.includes(secret) || request.path.includes(secret))) {
      output.note('write denied', 'The proposed write contains the configured API secret and cannot be displayed for review.');
      return false;
    }
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(request.path)) {
      output.note('write denied', 'The proposed target contains control characters or invalid Unicode and cannot be displayed exactly.');
      return false;
    }
    if (Buffer.byteLength(request.content, 'utf8') > 64 * 1024 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(request.content)) {
      output.note('write denied', 'Content must be printable UTF-8 text of at most 64 KiB, with optional tabs and line feeds.');
      return false;
    }
    process.stdout.write('\n' + accent(request.existing ? 'WRITE APPROVAL · replace existing file' : 'WRITE APPROVAL · create file') + '\n');
    output.text('Target (quoted): ' + JSON.stringify(request.path));
    output.text(`Full proposed content: ${count(Buffer.byteLength(request.content, 'utf8'))} bytes`);
    output.text('Quoted segments below concatenate exactly to the file; \\n and \\t are escaped.');
    process.stdout.write(dim('─'.repeat(Math.min(72, process.stdout.columns || 72))) + '\n');
    const contentLines = request.content.split('\n');
    output.text(contentLines.map((line, index) => JSON.stringify(line + (index < contentLines.length - 1 ? '\n' : ''))).join('\n'));
    process.stdout.write(dim('─'.repeat(Math.min(72, process.stdout.columns || 72))) + '\n');
    await input.approvalBoundary();
    if (exiting || active?.signal.aborted) return false;
    const answer = await input.ask('Approve write? [y/N] ');
    const cancelled = input.consumeCancellation();
    const approved = !cancelled && !exiting && !active?.signal.aborted && answer?.trim().toLowerCase() === 'y';
    output.note('write', approved ? 'Approved.' : 'Denied.');
    return approved;
  });

  try {
    header();
    let continuation = '';
    while (!exiting) {
      const line = await input.ask(continuation ? '  … ' : 'sun › ', true);
      if (line === null) break;
      if (input.consumeCancellation()) { continuation = ''; continue; }
      const trailingSlashes = /\\+$/.exec(line)?.[0].length ?? 0;
      if (trailingSlashes % 2 === 1) { continuation += line.slice(0, -1) + '\n'; continue; }
      const text = continuation + line;
      continuation = '';
      if (!text.trim()) continue;
      if (/^\/(?:quit|exit)\s*$/i.test(text.trim())) break;
      output.reset();
      let streamFilter: StreamTextFilter | undefined;
      try {
        if (text.trimStart().startsWith('/') && !/^\/task(?:\s|$)/i.test(text.trimStart())) {
          const result = await controller.command(text.trim());
          if (result) output.text(result);
          continue;
        }
        active = new AbortController();
        streamFilter = new StreamTextFilter(controller.config.apiKey);
        output.note('working', 'Streaming reply · Ctrl+C cancels');
        const result = await controller.submit(text, event => {
          if (event.type === 'delta') output.delta(streamFilter!.write(event.text));
          else if (event.type === 'status') output.note('status', event.text);
          else if (event.type === 'memory') {
            const sources = event.hits.slice(0, 2).map(hit => compact(hit.source, 60)).join(', ');
            output.note('memory', `${count(event.hits.length)} recalled chunks · active input ~${count(event.inputEstimate)} tokens (estimated)${sources ? ' · ' + sources : ''}`);
          } else if (event.type === 'tool') output.note('tool', summarizeTool(event));
        }, active.signal);
        output.delta(streamFilter.flush());
        if (!output.receivedText && result.text) output.delta(result.text);
        output.finishLine();
        if (active.signal.aborted) output.note('cancelled', 'Turn stopped.');
        else {
          const usage = result.usage;
          const reported = usage?.promptTokens !== undefined || usage?.completionTokens !== undefined
            ? ` · server usage: ${usage.promptTokens === undefined ? '?' : count(usage.promptTokens)} input / ${usage.completionTokens === undefined ? '?' : count(usage.completionTokens)} output`
            : '';
          output.note('done', `${count(result.steps)} step${result.steps === 1 ? '' : 's'} · input ~${count(result.inputEstimate)} tokens (estimated)${reported}`);
        }
      } catch (error) {
        output.delta(streamFilter?.flush() ?? '');
        if (active?.signal.aborted) output.note('cancelled', 'Turn stopped.');
        else output.note('error', error instanceof Error ? error.message : String(error));
      } finally { active = undefined; }
      if (!exiting) process.stdout.write('\n');
    }
  } finally {
    active?.abort();
    controller.setConfirm(async () => false);
    input.close();
    output.finishLine();
  }
}
