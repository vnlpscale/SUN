import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, estimateInput, Harness, InterruptedTurn } from '../src/harness.js';
import type { Memory, Message, Provider, SunConfig, ToolRuntime } from '../src/types.js';
import { loadConfig } from '../src/config.js';

const config: SunConfig = loadConfig(['--demo'], {}).config;
const memory: Memory = { ingest: () => ({ inserted: 0, duplicates: 0 }), search: () => [], stats: () => ({ chunks: 0, sources: 0, bytes: 0, estimatedTokens: 0 }), close() {} };
const tools: ToolRuntime = { definitions: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }], execute: async () => 'result' };
test('context keeps complete recent tool transactions and respects budget with Unicode evidence', () => {
  const history: Message[] = [{ role: 'user', content: 'old '.repeat(4000) }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'read' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'read_file', arguments: '{}' }] }, { role: 'tool', content: 'data', tool_call_id: 'a' }, { role: 'assistant', content: 'done' }];
  const context = buildContext(history, [{ role: 'user', content: 'new task' }], [{ id: 'x', source: 'doc', ordinal: 0, score: 1, text: '漢字'.repeat(2000) }], config, []);
  assert.ok(context.inputEstimate <= config.contextTokens - config.outputTokens);
  assert.equal(context.inputEstimate, estimateInput(context.messages, []));
  assert.ok(context.messages.some(m => m.role === 'tool'));
  assert.ok(!context.messages.some(m => m.content.startsWith('old ')));
  assert.equal(context.recalled.length, 0);
});
test('oversized current user task is rejected before model request', async () => {
  let called = false;
  const provider: Provider = { async *stream() { called = true; yield { type: 'delta', text: 'bad' }; } };
  await assert.rejects(new Harness(config, provider, memory, tools).run('x'.repeat(9000), [], () => {}), /prompt budget/);
  assert.equal(called, false);
});
test('tool loop appends results and removes tools at final step', async () => {
  let requests = 0;
  const provider: Provider = { async *stream(request) {
    requests++;
    if (requests === 1) yield { type: 'tool_call', call: { id: 't', name: 'read_file', arguments: '{}' } };
    else { assert.equal(request.tools.length, 0); assert.equal(request.messages.at(-1)?.role, 'tool'); yield { type: 'delta', text: 'Grounded answer' }; }
  } };
  const result = await new Harness({ ...config, toolsEnabled: true, maxSteps: 2 }, provider, memory, tools).run('read', [], () => {});
  assert.equal(result.steps, 2); assert.equal(result.text, 'Grounded answer'); assert.equal(result.messages[2]?.role, 'tool');
});
test('backend cannot execute tools when operator has disabled them', async () => {
  let executed = false;
  const provider: Provider = { async *stream() { yield { type: 'tool_call', call: { id: 't', name: 'read_file', arguments: '{}' } }; } };
  await assert.rejects(new Harness(config, provider, memory, { ...tools, execute: async () => { executed = true; return 'bad'; } }).run('task', [], () => {}), /disabled/);
  assert.equal(executed, false);
});
test('cancelled stream returns a recoverable transcript with partial response', async () => {
  const abort = new AbortController();
  const provider: Provider = { async *stream() { yield { type: 'delta', text: 'partial' }; abort.abort(); throw new Error('Cancelled.'); } };
  try { await new Harness(config, provider, memory, tools).run('task', [], () => {}, abort.signal); assert.fail('expected cancellation'); }
  catch (e) { assert.ok(e instanceof InterruptedTurn); assert.match(e.messages.at(-1)!.content, /partial/); }
});
