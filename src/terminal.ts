/** Stateful filtering prevents fragmented escape sequences and secret echoes. */
export class StreamTextFilter {
  private pending = '';
  private mode: 'plain' | 'escape' | 'csi' | 'osc' | 'oscEscape' = 'plain';
  constructor(private readonly secret?: string) {}
  write(chunk: string): string {
    // Normalize display text first: escapes inserted inside a key must not
    // reveal it once the terminal controls have been removed.
    this.pending += this.sanitize(chunk);
    if (this.secret) this.pending = this.pending.replaceAll(this.secret, '[redacted]');
    const retain = this.secret ? this.secret.length - 1 : 0;
    const cut = Math.max(0, this.pending.length - retain);
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return ready;
  }
  flush(): string {
    const ready = this.secret ? this.pending.replaceAll(this.secret, '[redacted]') : this.pending;
    this.pending = '';
    return ready;
  }
  private sanitize(chunk: string): string {
    let output = '';
    for (const character of chunk) {
      const code = character.codePointAt(0)!;
      if (this.mode === 'oscEscape') { this.mode = character === '\\' ? 'plain' : 'osc'; continue; }
      if (this.mode === 'osc') {
        if (code === 7) this.mode = 'plain';
        else if (code === 27) this.mode = 'oscEscape';
        continue;
      }
      if (this.mode === 'csi') { if (code >= 0x40 && code <= 0x7e) this.mode = 'plain'; continue; }
      if (this.mode === 'escape') {
        this.mode = character === '[' ? 'csi' : character === ']' ? 'osc' : 'plain'; continue;
      }
      if (code === 27) { this.mode = 'escape'; continue; }
      if (code === 0x9b) { this.mode = 'csi'; continue; }
      if (code === 0x9d) { this.mode = 'osc'; continue; }
      if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) continue;
      if (code === 9 || code === 10 || (code >= 32 && !(code >= 0x7f && code <= 0x9f))) output += character;
    }
    return output;
  }
}
export function safeTerminalText(text: string, secret?: string): string {
  const filter = new StreamTextFilter(secret);
  return filter.write(text) + filter.flush();
}
