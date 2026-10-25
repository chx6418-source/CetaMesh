import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  CredentialReader,
  ModelInfo,
  ModelProvider,
  ProviderConfig,
} from '../../domain/model/ModelProvider';
import { CetaError } from '../../shared/errors/CetaError';
import type { HttpTransport } from '../network/HttpTransport';
import { SseDecoder } from '../network/SseDecoder';
import {normalizeTokenUsage} from './TokenUsageNormalization';

import { validateEndpoint } from '../../shared/utils/endpoint';
export { validateEndpoint } from '../../shared/utils/endpoint';

export class CompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  constructor(
    private readonly config: ProviderConfig,
    private readonly credentials: CredentialReader,
    private readonly http: HttpTransport,
  ) {
    this.id = config.id;
    this.baseUrl = validateEndpoint(config.baseUrl);
  }
  private async headers(): Promise<Record<string, string>> {
    const secret = await this.credentials.get(this.config.credentialRef);
    if (!secret) {
      throw new CetaError('unauthorized', 'Save an API key for this provider');
    }
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + secret,
    };
  }
  async listModels(): Promise<ModelInfo[]> {
    const body = (await this.http.json({
      url: this.baseUrl + '/models',
      headers: await this.headers(),
    })) as { data?: { id?: unknown }[] };
    if (!body || !Array.isArray(body.data)) {
      throw new CetaError('invalid_protocol', 'Invalid model list');
    }
    return body.data
      .filter(item => typeof item?.id === 'string')
      .map(item => ({
        id: item.id as string,
        name: item.id as string,
        supportsReasoning: this.config.supportsReasoning,
      }));
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    let content = '';
    for await (const chunk of this.stream(request)) {
      if (chunk.type === 'delta') {
        content += chunk.text;
      }
    }
    return { content };
  }
  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    if (request.signal?.aborted) {
      throw new CetaError('cancelled', 'Request cancelled');
    }
    const decoder = new SseDecoder();
    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: request.messages,
      stream: true,
      stream_options: {include_usage: true},
    };
    if (this.config.supportsReasoning) {
      body.reasoning_effort = {
        fast: 'low',
        standard: 'medium',
        high: 'high',
        max: 'high',
      }[request.reasoning];
    }
    try {
      for await (const text of this.http.stream({
        url: this.baseUrl + '/chat/completions',
        headers: await this.headers(),
        body,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        streaming: true,
      })) {
        for (const data of decoder.push(text)) {
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }
          let parsed: {
            error?: unknown;
            choices?: {
              delta?: { content?: unknown };
              finish_reason?: unknown;
            }[];
            usage?: unknown;
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new CetaError('invalid_protocol', 'Malformed stream frame');
          }
          if (!parsed || parsed.error) {
            throw new CetaError('provider_error', 'Provider stream failed');
          }
          if (!Array.isArray(parsed.choices)) {
            throw new CetaError('invalid_protocol', 'Invalid stream frame');
          }
          const usage = normalizeTokenUsage(parsed.usage);
          if (usage) {yield {type: 'usage', usage};}
          const content = parsed.choices[0]?.delta?.content;
          if (typeof content === 'string') {
            yield { type: 'delta', text: content };
          } else if (content != null) {
            throw new CetaError('invalid_protocol', 'Invalid stream content');
          }
        }
      }
      throw new CetaError(
        'network_unavailable',
        'Stream interrupted before completion',
      );
    } catch (error) {
      throw error instanceof CetaError
        ? error
        : new CetaError('provider_error', 'Provider request failed');
    }
  }
}
