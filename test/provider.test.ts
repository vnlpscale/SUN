import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { DemoProvider, OpenAICompatibleProvider, createProvider } from '../src/provider.js';
import type { ProviderEvent, ProviderRequest, SunConfig } from '../src/types.js';

const tools = [{ name: 'read_file', description: 'Read text', parameters: { type: 'object' } }];
function config(endpoint: string, overrides: Partial<SunConfig> = {}): SunConfig {
  return {
    endpoint, apiKey: 'test-secret-never-echo', model: 'test-model',
    preset: { id: 'test', label: 'test', model: 'test-model', contextLimit: 8192, contextEvidence: 'test', vision: false, toolsVerified: false, sources: [] },
    contextTokens: 8192, outputTokens: 64, maxSteps: 3, dataDir: '.sun', workspace: process.cwd(), demo: false, toolsEnabled: true,
    ...overrides,
  };
}
const request: ProviderRequest = { messages: [{ role: 'user', content: 'Hello' }], tools, maxTokens: 64 };
async function collect(provider: OpenAICompatibleProvider | DemoProvider, input = request): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(input)) events.push(event);
  return events;
}
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/v1`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function mockFetch(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = previous; }
}
function fragmentedResponse(text: string, width = 2): Response {
  const bytes = Buffer.from(text, 'utf8');
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += width) controller.enqueue(bytes.subarray(offset, offset + width));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(Buffer.from(part));
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
}

test('provider handles byte-fragmented UTF-8, CRLF, multiline events, tool fragments, and usage', { timeout: 10_000 }, async () => {
  let posted: Record<string, unknown> | undefined;
  await mockFetch(async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:12345/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-secret-never-echo');
    posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const events = [
      ': keepalive\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{"content":"雪☀"}}]}\r\n\r\n',
      'data: {"choices":[\r\ndata: {"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"read_","arguments":"{\\\"pa"}}]}}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"file","arguments":"th\\\":\\\"README.md\\\"}"}}]},"finish_reason":"tool_calls"}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":5}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join('');
    return fragmentedResponse(events);
  }, async () => {
    const messages: ProviderRequest['messages'] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'previous', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', content: '{}', tool_call_id: 'previous' },
      ...request.messages,
    ];
    const events = await collect(new OpenAICompatibleProvider(config('http://127.0.0.1:12345/v1')), { ...request, messages });
    assert.deepEqual(events, [
      { type: 'delta', text: '雪☀' },
      { type: 'usage', usage: { promptTokens: 15, completionTokens: 5 } },
      { type: 'tool_call', call: { id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' } },
    ]);
  });
  assert.ok(posted);
  assert.equal(posted.model, 'test-model');
  assert.equal(posted.stream, true);
  assert.equal(posted.max_tokens, 64);
  assert.deepEqual(posted.tools, [{ type: 'function', function: tools[0] }]);
  assert.deepEqual((posted.messages as unknown[])[0], { role: 'assistant', content: '', tool_calls: [{ id: 'previous', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
  assert.equal(((posted.messages as Record<string, unknown>[])[1])?.tool_call_id, 'previous');
});

test('provider leaves native tool definitions out when tools are disabled', { timeout: 10_000 }, async () => {
  await serve(async (req, res) => {
    const body = await jsonBody(req);
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\n');
  }, async url => {
    assert.deepEqual(await collect(new OpenAICompatibleProvider(config(url, { toolsEnabled: false }))), [{ type: 'delta', text: 'ready' }]);
  });
});

test('provider reads a final buffered event without a trailing newline', { timeout: 10_000 }, async () => {
  await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}');
  }, async url => {
    assert.deepEqual(await collect(new OpenAICompatibleProvider(config(url))), [{ type: 'delta', text: 'complete' }]);
  });
});

test('provider cancels a stalled streaming response through AbortSignal', { timeout: 10_000 }, async () => {
  await mockFetch(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      init?.signal?.addEventListener('abort', () => controller.error(new Error('mock abort')), { once: true });
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }), async () => {
    const controller = new AbortController();
    const iterator = new OpenAICompatibleProvider(config('http://127.0.0.1:12345/v1')).stream({ ...request, signal: controller.signal })[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, { type: 'delta', text: 'first' });
    controller.abort();
    await assert.rejects(iterator.next(), /cancelled/);
  });
});

test('provider errors give status guidance without reflecting secrets or server bodies', { timeout: 10_000 }, async () => {
  await serve((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"test-secret-never-echo sensitive-server-message"}');
  }, async url => {
    await assert.rejects(collect(new OpenAICompatibleProvider(config(url))), error => {
      const text = String(error);
      return text.includes('HTTP 401') && text.includes('authentication') && !text.includes('test-secret') && !text.includes('sensitive-server') && !text.includes(url);
    });
  });
  await assert.rejects(collect(new OpenAICompatibleProvider(config('http://secret-name:secret-password@127.0.0.1:1/v1'))), error => !String(error).includes('secret-'));
  await assert.rejects(collect(new OpenAICompatibleProvider(config('http://remote.example/v1'))), /HTTPS/);
  await assert.rejects(collect(new OpenAICompatibleProvider(config('http://127.0.0.1:1/v1?key=test-secret'))), error => !String(error).includes('test-secret'));
});

test('provider rejects truncated streams, invalid JSON, and incomplete tool arguments', { timeout: 10_000 }, async () => {
  const cases: [string, RegExp][] = [
    ['data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n', /completion marker/],
    ['data: server-body-with-secret\n\n', /invalid streaming JSON/],
    ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"read_file","arguments":"{"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', /complete JSON object/],
    ['data: {"error":{"message":"test-secret-never-echo"}}\n\n', /reported an error/],
  ];
  for (const [body, expected] of cases) {
    await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(body); }, async url => {
      await assert.rejects(collect(new OpenAICompatibleProvider(config(url))), error => expected.test(String(error)) && !String(error).includes('test-secret'));
    });
  }
});

test('provider rejects oversized stream events before emitting unbounded output', { timeout: 10_000 }, async () => {
  await mockFetch(async () => fragmentedResponse(`data: ${'x'.repeat(1024 * 1024 + 1)}\n\n`, 64 * 1024), async () => {
    await assert.rejects(collect(new OpenAICompatibleProvider(config('http://127.0.0.1:12345/v1'))), /size limit/);
  });
});

test('provider preserves emitted text but rejects truncated and filtered completion reasons', { timeout: 10_000 }, async () => {
  for (const reason of ['length', 'content_filter', 'unexpected-server-value']) {
    await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' }, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
    }, async url => {
      let partial = '';
      await assert.rejects(async () => {
        for await (const event of new OpenAICompatibleProvider(config(url)).stream(request)) if (event.type === 'delta') partial += event.text;
      }, /incomplete/);
      assert.equal(partial, 'partial answer');
    });
  }
});

test('demo provider is offline and supports a deterministic memory tool turn', { timeout: 10_000 }, async () => {
  const provider = createProvider(config('invalid-endpoint-not-used', { demo: true }));
  assert.ok(provider instanceof DemoProvider);
  const input = { ...request, tools: [{ name: 'search_memory', description: 'Search memory', parameters: {} }] };
  const first = await collect(provider, input);
  assert.equal(first[0]?.type, 'tool_call');
  const second = await collect(provider, { ...input, messages: [...input.messages, { role: 'tool', content: '[]', tool_call_id: 'demo_memory_1' }] });
  const text = second.filter(event => event.type === 'delta').map(event => event.text).join('');
  assert.match(text, /SUN demo/);
  assert.match(text, /1T-token.*experimental external corpus/);
});
