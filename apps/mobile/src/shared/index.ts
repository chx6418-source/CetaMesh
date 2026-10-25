export type CorrelationContext = {
  readonly traceId?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly deviceId?: string;
  readonly eventId?: string;
};

