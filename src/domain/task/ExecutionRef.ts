export type ExecutionState = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type ContextUsage = {
  readonly usedTokens?: number;
  readonly limitTokens?: number;
  readonly percent?: number;
};

export type ExecutionRef = {
  readonly providerId: string;
  readonly executionId: string;
  readonly sessionId?: string;
  readonly state: ExecutionState;
  readonly contextUsage?: ContextUsage;
};
