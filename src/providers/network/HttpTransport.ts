export type HttpRequest = {
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  streaming?: boolean;
};
export interface HttpTransport {
  json(request: HttpRequest): Promise<unknown>;
  stream(request: HttpRequest): AsyncIterable<string>;
}
