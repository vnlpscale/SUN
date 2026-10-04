#!/usr/bin/env node
import { loadConfig, CLI_HELP } from './config.js';
import { SunApp } from './app.js';
import { runTui } from './tui.js';
import { safeTerminalText, StreamTextFilter } from './terminal.js';

// Strip control sequences from all untrusted text even in one-shot mode.
export function terminalSafe(text: string): string {
  return safeTerminalText(text, process.env.SUN_API_KEY);
}
async function main(): Promise<void> {
  const { config, prompt, help } = loadConfig(process.argv.slice(2));
  if (help) { console.log(CLI_HELP); return; }
  const app = new SunApp(config);
  try {
    if (prompt !== undefined) {
      const abort = new AbortController();
      const onInterrupt = () => abort.abort(new Error('Cancelled.'));
      process.on('SIGINT', onInterrupt);
      try {
        if (prompt.startsWith('/') && !prompt.startsWith('/task ')) console.log(terminalSafe(await app.command(prompt)));
        else {
          const filter = new StreamTextFilter(config.apiKey);
          try { await app.submit(prompt, event => { if (event.type === 'delta') process.stdout.write(filter.write(event.text)); }, abort.signal); }
          finally { process.stdout.write(filter.flush() + '\n'); }
        }
      } finally { process.removeListener('SIGINT', onInterrupt); }
    } else await runTui(app);
  } finally { app.close(); }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : 'SUN could not complete the request.';
  // Never print server bodies, config objects, stack traces, or a supplied key.
  const secret = process.env.SUN_API_KEY;
  console.error(`SUN: ${terminalSafe(secret ? message.replaceAll(secret, '[redacted]') : message)}`);
  process.exitCode = 1;
});
