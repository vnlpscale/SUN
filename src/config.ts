import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { ModelPreset, SunConfig } from './types.js';
import { buildContext } from './harness.js';
import { TOOL_DEFINITIONS } from './tools.js';

export const PRESETS: ModelPreset[] = [
  { id: 'speedx27', label: 'SpeedX27 · 27B VL GDN64', model: 'summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64',
    contextLimit: 262144, contextEvidence: 'Publisher config validated=262144; card tests 262144 prefill + one-token decode. Recall untested.',
    vision: true, toolsVerified: false,
    sources: ['https://huggingface.co/summerMC/Qwen3.8-27B-SpeedX27-VL-GDN64/resolve/064d702bc63e20042d00f3308f01509f99a8879f/config.json'] },
  { id: 'speedx2', label: 'SpeedX · 2B GDN24', model: 'j-llm/Qwen3.5-2B-SpeedX',
    contextLimit: 16384, contextEvidence: 'Conservative card benchmark boundary=16384; config claims validated=262144. Recall untested.',
    vision: false, toolsVerified: false,
    sources: ['https://huggingface.co/j-llm/Qwen3.5-2B-SpeedX/resolve/898730fd0900f70f1eccfc864d5136ce0e3b94b4/README.md'] },
  { id: 'custom', label: 'Custom · server capability required', model: 'local-model', contextLimit: null,
    contextEvidence: 'Unknown; verify the served context and model ID with your backend.', vision: false, toolsVerified: false, sources: [] }
];

export function presetFor(value: string): ModelPreset {
  const preset = PRESETS.find(p => p.id === value || p.model === value);
  if (!preset) throw new Error('Unknown preset. Use speedx27, speedx2, or custom.');
  return { ...preset, sources: [...preset.sources] };
}

export function integer(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} must be from ${min} to ${max}.`);
  return result;
}

export function loadConfig(args: string[], env: NodeJS.ProcessEnv = process.env): { config: SunConfig; prompt?: string; help: boolean } {
  const values: Record<string, string> = {};
  let demo = false, toolsEnabled = false, help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--demo') { demo = true; continue; }
    if (arg === '--tools') { toolsEnabled = true; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (!['--endpoint', '--preset', '--model', '--context', '--output', '--steps', '--workspace', '--prompt'].includes(arg)) throw new Error(`Unknown option: ${arg.replace(/[\x00-\x1f\x7f]/g, '')}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    values[arg.slice(2)] = value;
  }
  const preset = presetFor(values.preset ?? env.SUN_PRESET ?? 'speedx27');
  const endpoint = values.endpoint ?? env.SUN_ENDPOINT ?? 'http://127.0.0.1:8000/v1';
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Endpoint must be a valid http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Endpoint must be http(s), without URL credentials, query, or fragment.');
  const apiKey = env.SUN_API_KEY;
  if (apiKey && url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS when sending a key to a remote endpoint.');
  const contextTokens = integer(values.context ?? env.SUN_CONTEXT ?? '8192', 'Context', 4096, preset.contextLimit ?? 262144);
  const outputTokens = integer(values.output ?? env.SUN_OUTPUT ?? '1024', 'Output', 128, Math.min(8192, Math.floor(contextTokens / 2)));
  const workspace = realpathSync(path.resolve(values.workspace ?? process.cwd()));
  const config: SunConfig = { endpoint: url.toString().replace(/\/$/, ''), apiKey, preset,
    model: values.model ?? env.SUN_MODEL ?? preset.model, contextTokens, outputTokens,
    maxSteps: integer(values.steps ?? '6', 'Steps', 1, 12), workspace,
    dataDir: path.join(workspace, '.sun'), demo, toolsEnabled };
  if (values.model && preset.id !== 'custom' && values.model !== preset.model) throw new Error('Use --preset custom when overriding the model ID.');
  if (env.SUN_MODEL && preset.id !== 'custom' && config.model !== preset.model) throw new Error('Use SUN_PRESET=custom when overriding the model ID.');
  buildContext([], [{ role: 'user', content: 'Minimum task' }], [], config, toolsEnabled ? TOOL_DEFINITIONS : []);
  return { config, prompt: values.prompt, help };
}

export const CLI_HELP = `SUN · a bounded AI harness with external memory

  npm run demo                         offline interactive demo
  npm start -- --preset speedx2         connect to localhost:8000/v1
  npm start -- --prompt "Explain SUN"  one-shot streaming output

Options: --demo --preset speedx27|speedx2|custom --model ID
         --endpoint URL --context 8192 --output 1024 --steps 6
         --workspace PATH --tools --prompt TEXT --help
Environment: SUN_ENDPOINT SUN_PRESET SUN_MODEL SUN_CONTEXT SUN_OUTPUT SUN_API_KEY
Secrets are read from the environment only. Tools require backend support.
1T is an untested logical corpus goal; it is never sent as a native context window.
Commands: /help /status /model /tools /ingest /memory /new /sessions /resume /task /quit`;
