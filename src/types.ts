export interface ToolCall { id: string; name: string; arguments: string }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface Usage { promptTokens?: number; completionTokens?: number }
export type ProviderEvent = { type: 'delta'; text: string } | { type: 'tool_call'; call: ToolCall } | { type: 'usage'; usage: Usage };
export interface ProviderRequest { messages: Message[]; tools: ToolDefinition[]; maxTokens: number; signal?: AbortSignal }
export interface Provider { stream(request: ProviderRequest): AsyncIterable<ProviderEvent> }
export interface MemoryHit { id: string; source: string; text: string; score: number; ordinal: number }
export interface MemoryStats { chunks: number; sources: number; bytes: number; estimatedTokens: number }
export interface Memory {
  ingest(text: string, source: string): { inserted: number; duplicates: number };
  search(query: string, limit?: number): MemoryHit[];
  stats(): MemoryStats;
  close(): void;
}
export interface StoredSession { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[] }
export interface ModelPreset {
  id: string; label: string; model: string; contextLimit: number | null;
  contextEvidence: string; vision: boolean; toolsVerified: boolean; sources: string[];
}
export interface SunConfig {
  endpoint: string; apiKey?: string; model: string; preset: ModelPreset;
  contextTokens: number; outputTokens: number; maxSteps: number; dataDir: string;
  workspace: string; demo: boolean; toolsEnabled: boolean;
}
export interface TurnResult { text: string; messages: Message[]; steps: number; recalled: MemoryHit[]; inputEstimate: number; usage?: Usage }
export type HarnessEvent = { type: 'delta'; text: string } | { type: 'status'; text: string } | { type: 'memory'; hits: MemoryHit[]; inputEstimate: number } | { type: 'tool'; name: string; state: 'requested' | 'done'; text: string };
export interface ToolRuntime {
  definitions: ToolDefinition[];
  execute(call: ToolCall): Promise<string>;
}
export type ConfirmWrite = (request: { path: string; content: string; existing: boolean }) => Promise<boolean>;
