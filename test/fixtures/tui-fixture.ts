import { createHash } from 'node:crypto';
import { runTui } from '../../src/tui.js';
import type { ConfirmWrite, SunConfig } from '../../src/types.js';

// A child-process-only terminal stand-in exercises approval input without changing the test runner's stdio.
if (process.argv.includes('--interactive')) {
  Object.defineProperty(process.stdin, 'isTTY', { value: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80 });
  Object.defineProperty(process.stdin, 'setRawMode', { value: () => process.stdin });
  process.env.TERM = 'xterm';
}

const secret = 'fixture-private-key-123';
const content = Array.from({ length: 96 }, (_, index) => `line ${index}: ${'abc'.repeat(30)}`).join('\n') + '\nVISIBLE_REVIEW_TAIL\n';
const config: SunConfig = {
  endpoint: 'http://127.0.0.1:1234/v1', apiKey: secret, model: 'fixture/model',
  preset: { id: 'fixture', label: 'Fixture', model: 'fixture/model', contextLimit: 8192, contextEvidence: 'Fixture only', vision: false, toolsVerified: false, sources: [] },
  contextTokens: 1024, outputTokens: 128, maxSteps: 2, dataDir: '.', workspace: process.cwd(), demo: false, toolsEnabled: true,
};
let confirm: ConfirmWrite = async () => false;
await runTui({
  config,
  session: () => ({ id: 'fixture', title: 'Fixture', createdAt: '', updatedAt: '', messages: [] }),
  memoryStats: () => ({ chunks: 0, sources: 0, bytes: 0, estimatedTokens: 0 }),
  setConfirm: callback => { confirm = callback; },
  command: async () => 'fixture command',
  submit: async (text, emit, signal) => {
    if (text.startsWith('write')) {
      const proposed = text === 'write-control' ? 'unsafe\x1b[2Jcontent' : content;
      const approved = await confirm({ path: 'notes.txt', content: proposed, existing: false });
      emit({ type: 'status', text: 'WRITE_CONTENT_SHA256:' + createHash('sha256').update(proposed).digest('hex') });
      emit({ type: 'status', text: 'WRITE_RESULT:' + (approved ? 'approved' : 'denied') });
    } else {
      emit({ type: 'delta', text: 'reply alpha ' + secret.slice(0, 7) + '\x1b[' });
      emit({ type: 'delta', text: '2J' + secret.slice(7) + ' omega\n' });
    }
    return { text: '', messages: [], steps: 1, recalled: [], inputEstimate: 20 };
  },
});
