export type WorkflowStep =
  | {readonly kind: 'tool-call'; readonly toolId: string}
  | {readonly kind: 'memory-read'; readonly query: string}
  | {readonly kind: 'task-update'; readonly field: string}
  | {readonly kind: 'approval'; readonly capability: string};

export type WorkflowDefinition = {readonly id: string; readonly version: string; readonly steps: readonly WorkflowStep[]};
