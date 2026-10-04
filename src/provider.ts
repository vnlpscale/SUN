import type { Message, Provider, ProviderEvent, ProviderRequest, SunConfig, ToolCall } from './types.js';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_CHARS = 1024 * 1024;
const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_ARGUMENT_CHARS = 65_536;
const MAX_TOOL_CALLS = 8;

class ProviderError extends Error {}

function completionsUrl(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ProviderError('Invalid model endpoint. Supply an HTTP(S) base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('Model endpoint must be HTTP(S), without credentials, query parameters, or a fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) {
    throw new ProviderError('Use HTTPS for remote endpoints. HTTP is allowed only for a loopback model server.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.toString();
}

function serializeMessage(message: Message): Record<string, unknown> {
  const result: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_calls?.length) {
    result.tool_calls = message.tool_calls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.role === 'tool') result.tool_call_id = message.tool_call_id;
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** OpenAI-compatible Chat Completions transport. No model-specific code is executed. */
export class OpenAICompatibleProvider implements Provider {
  constructor(private readonly config: SunConfig) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 32_768) {
      throw new ProviderError('Requested output must be between 1 and 32,768 tokens.');
    }
    const url = completionsUrl(this.config.endpoint);
    const enabledTools = this.config.toolsEnabled ? request.tools : [];
    const body = JSON.stringify({
      model: this.config.model,
      messages: request.messages.map(serializeMessage),
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(enabledTools.length ? {
        tools: enabledTools.map(tool => ({ type: 'function', function: tool })),
        tool_choice: 'auto', parallel_tool_calls: false,
      } : {}),
    });
    if (Buffer.byteLength(body, 'utf8') > 8 * 1024 * 1024) throw new ProviderError('Model request exceeds the 8 MiB transport limit.');

    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    request.signal?.addEventListener('abort', cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    timeout.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
      const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? ' Check endpoint authentication.'
          : response.status === 404 ? ' Check the endpoint path and served model ID.'
          : response.status === 429 ? ' The server is rate limited; try again later.'
          : response.status === 400 ? ' Check model support for the configured context, output, and tool settings.' : ' Check the model server.';
        throw new ProviderError(`Model server returned HTTP ${response.status}.${hint}`);
      }
      if (!response.body) throw new ProviderError('Model server returned an empty streaming response.');
      const contentType = response.headers.get('content-type');
      if (contentType && !contentType.toLowerCase().includes('text/event-stream')) {
        throw new ProviderError('Model server must support Chat Completions with text/event-stream responses.');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const calls = new Map<number, ToolCall>();
      const events: string[] = [];
      let line = '';
      let data: string[] = [];
      let dataLength = 0;
      let afterCR = false;
      let streamBytes = 0;
      let textChars = 0;
      let done = false;
      let sawCompletion = false;
      let incompleteReason: 'length' | 'content_filter' | 'unknown' | undefined;
      const handleLine = () => {
        if (!line) {
          if (data.length) events.push(data.join('\n'));
          data = [];
          dataLength = 0;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          dataLength += value.length + 1;
          if (dataLength > MAX_EVENT_CHARS) throw new ProviderError('Model stream event exceeds its size limit.');
          data.push(value);
        }
        line = '';
      };
      const feed = (chunk: string) => {
        for (const character of chunk) {
          if (character === '\r') { handleLine(); afterCR = true; }
          else if (character === '\n') { if (!afterCR) handleLine(); afterCR = false; }
          else {
            afterCR = false;
            line += character;
            if (line.length > MAX_EVENT_CHARS) throw new ProviderError('Model stream line exceeds its size limit.');
          }
        }
      };
      const parse = (event: string): ProviderEvent[] => {
        if (event.trim() === '[DONE]') { done = true; sawCompletion = true; return []; }
        let parsed: Record<string, unknown> | undefined;
        try { parsed = object(JSON.parse(event)); } catch { throw new ProviderError('Model server sent invalid streaming JSON.'); }
        if (!parsed) throw new ProviderError('Model server sent an invalid streaming event.');
        if (parsed.error) throw new ProviderError('Model server reported an error in its stream. Check the server logs.');
        const output: ProviderEvent[] = [];
        const usage = object(parsed.usage);
        if (usage) output.push({ type: 'usage', usage: {
          promptTokens: positiveTokenCount(usage.prompt_tokens), completionTokens: positiveTokenCount(usage.completion_tokens),
        } });
        if (!Array.isArray(parsed.choices)) return output;
        for (const rawChoice of parsed.choices) {
          const choice = object(rawChoice);
          if (!choice || (choice.index !== undefined && choice.index !== 0)) continue;
          if (choice.finish_reason != null) {
            if (choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') sawCompletion = true;
            else incompleteReason = choice.finish_reason === 'length' || choice.finish_reason === 'content_filter' ? choice.finish_reason : 'unknown';
          }
          const delta = object(choice.delta);
          if (!delta) continue;
          if (typeof delta.content === 'string') {
            textChars += delta.content.length;
            if (textChars > MAX_TEXT_CHARS) throw new ProviderError('Model output exceeds its size limit.');
            output.push({ type: 'delta', text: delta.content });
          } else if (delta.content != null) throw new ProviderError('Only text model output is supported by this harness.');
          if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw new ProviderError('Model server sent invalid tool calls.');
          for (const rawCall of (delta.tool_calls as unknown[] | undefined) ?? []) {
            if (!enabledTools.length) throw new ProviderError('Model requested tools while native tools are disabled.');
            const fragment = object(rawCall);
            const index = fragment?.index;
            if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= MAX_TOOL_CALLS) {
              throw new ProviderError('Model requested too many or invalid tool calls.');
            }
            const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
            const fn = object(fragment?.function);
            if (typeof fragment?.id === 'string') call.id += fragment.id;
            if (typeof fn?.name === 'string') call.name += fn.name;
            if (typeof fn?.arguments === 'string') call.arguments += fn.arguments;
            if (call.id.length > 256 || call.name.length > 128 || call.arguments.length > MAX_ARGUMENT_CHARS) {
              throw new ProviderError('Model tool call exceeds its size limit.');
            }
            calls.set(index, call);
          }
        }
        return output;
      };
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) {
          feed(decoder.decode());
          if (line) handleLine();
          handleLine();
        } else {
          streamBytes += chunk.value.byteLength;
          if (streamBytes > MAX_STREAM_BYTES) throw new ProviderError('Model stream exceeds the 16 MiB transport limit.');
          feed(decoder.decode(chunk.value, { stream: true }));
        }
        while (events.length && !done) {
          for (const event of parse(events.shift()!)) yield event;
        }
        if (chunk.done) break;
      }
      if (incompleteReason) {
        const explanation = incompleteReason === 'length' ? 'the output token limit was reached'
          : incompleteReason === 'content_filter' ? 'the server applied a content filter' : 'the server reported an unsupported finish reason';
        throw new ProviderError(`Model output was incomplete: ${explanation}. Partial output was preserved.`);
      }
      if (!sawCompletion) throw new ProviderError('Model stream ended before a completion marker. Partial output was not accepted as a finished turn.');
      for (const [, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
        if (!call.id || !call.name || !enabledTools.some(tool => tool.name === call.name)) {
          throw new ProviderError('Model requested an incomplete or unavailable tool.');
        }
        try { if (!object(JSON.parse(call.arguments))) throw new Error(); }
        catch { throw new ProviderError('Model tool arguments must be a complete JSON object.'); }
        yield { type: 'tool_call', call };
      }
    } catch (error) {
      if (timedOut) throw new ProviderError('Model request timed out after 120 seconds.');
      if (request.signal?.aborted) throw new ProviderError('Model request cancelled.');
      if (error instanceof ProviderError) throw error;
      // Never expose fetch exceptions or server bodies: they can reflect credentials.
      throw new ProviderError('Unable to read the model stream. Check connectivity, endpoint settings, and server logs.');
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', cancel);
      // Aborting fetch releases its body. Awaiting reader.cancel() after abort can
      // stall with some Node fetch implementations even after an SSE DONE event.
      reader?.releaseLock();
      controller.abort();
    }
  }
}

/** Offline transport for trying the UI and task loop without credentials or compute. */
export class DemoProvider implements Provider {
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (request.signal?.aborted) throw new ProviderError('Model request cancelled.');
    const latest = request.messages.findLast(message => message.role === 'user')?.content ?? '';
    const toolReply = request.messages.at(-1)?.role === 'tool';
    if (!toolReply && request.tools.some(tool => tool.name === 'search_memory')) {
      yield { type: 'tool_call', call: { id: 'demo_memory_1', name: 'search_memory', arguments: JSON.stringify({ query: latest.slice(0, 2048), limit: 3 }) } };
      return;
    }
    const answer = `SUN demo is running locally. Your request: ${latest.slice(0, 500)}\n\n` +
      'I can retrieve bounded external memory and request approved workspace edits. Connect a compatible model server for a real model answer. ' +
      'The 1T-token goal describes an experimental external corpus target; active context remains bounded by the configured model window.';
    for (const part of answer.match(/.{1,28}|\n/gs) ?? []) {
      if (request.signal?.aborted) throw new ProviderError('Model request cancelled.');
      yield { type: 'delta', text: part };
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }
}

export function createProvider(config: SunConfig): Provider {
  return config.demo ? new DemoProvider() : new OpenAICompatibleProvider(config);
}
