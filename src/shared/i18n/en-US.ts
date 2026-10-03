import type {zhCN} from './zh-CN';

export const enUS: Record<keyof typeof zhCN, string> = {
  chat: 'Chat', tasks: 'Tasks', memory: 'Memory', workspace: 'Workspace',
  primaryNavigation: 'Primary navigation', closeSheet: 'Close sheet',
  loadingWorkspace: 'Preparing your workspace…', tryAgain: 'Try again',
  sessions: 'Sessions', newChat: 'New chat', recentSessions: 'Recent sessions',
  archived: 'Archived', providers: 'Model providers', devices: 'Devices',
  extensions: 'Plugins & tools', preferences: 'Preferences', advanced: 'Advanced',
  input: 'Input', output: 'Output', cacheHit: 'Cache hit',
  cacheMiss: 'Cache miss', cacheHitRate: 'Cache hit rate',
  sessionUsage: 'Session usage', sources: 'Sources', copy: 'Copy',
  regenerate: 'Regenerate', toolCall: 'Tool call',
};
