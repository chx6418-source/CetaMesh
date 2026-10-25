export type MemoryPackMemory = {readonly id: string; readonly content: string; readonly scope: 'local-only' | 'my-devices'};
export type MemoryPack = {
  readonly manifest: {readonly id: string; readonly name: string; readonly version: string};
  readonly memories: readonly MemoryPackMemory[];
  readonly entities: readonly Record<string, unknown>[];
  readonly relations: readonly Record<string, unknown>[];
  readonly license?: string;
  readonly signature?: Record<string, unknown>;
  readonly origin: 'third_party';
  readonly trust: 'untrusted';
  readonly readOnly: true;
};
