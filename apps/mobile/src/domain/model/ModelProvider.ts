export type Reasoning = 'fast' | 'standard' | 'high' | 'max';
export type ModelInfo = {
  id: string;
  name: string;
  supportsReasoning: boolean;
};
export type MessageContent =
  | string
  | readonly (
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    )[];
export type ChatRequest = {
  modelId: string;
  reasoning: Reasoning;
  messages: readonly { role: 'system' | 'user' | 'assistant'; content: MessageContent }[];
  signal?: AbortSignal;
  timeoutMs?: number;
};
import type {TokenUsage} from './TokenUsage';
export type ChatChunk = { type: 'delta'; text: string } | {type: 'usage'; usage: TokenUsage} | { type: 'done' };
export type ChatResponse = { content: string };
export type ProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  credentialRef: string;
  supportsReasoning: boolean;
};
export interface CredentialReader {
  get(reference: string): Promise<string | null>;
}
export interface ModelProvider {
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}
