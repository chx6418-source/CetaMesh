export type TaskStatus = 'working' | 'waiting' | 'paused' | 'completed';
export type AgentStatus = 'ready' | 'needs-setup' | 'not-installed' | 'not-supported' | 'unavailable';
export type PluginStatus = 'installed' | 'available' | 'update';

export interface ChatSessionView {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  unread?: boolean;
}

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  progress: number;
  agent: string | null;
  workspace: string;
  lastActivity: string;
}

export interface AgentView {
  id: string;
  name: string;
  role: string;
  description: string;
  status: AgentStatus;
  initials: string;
}

export interface PluginView {
  id: string;
  name: string;
  summary: string;
  developer: string;
  version: string;
  status: PluginStatus;
  category: '效率' | '连接' | '创作' | '开发';
  kind: 'integration' | 'extension';
  icon: 'sparkles' | 'plug' | 'music' | 'code' | 'globe' | 'image' | 'bot' | 'layers';
  permissions: string[];
  changelog: string;
}

export interface ModelView { id: string; name: string; provider: string; configured: boolean }
export interface MemoryView { id: string; title: string; summary: string; category: '知识' | '偏好' | '项目'; updatedAt: string }
export interface UpdateView { currentVersion: string; latestVersion: string | null; status: 'current' | 'available' | 'unknown' }
export interface AboutView { version: string | null; buildId: string | null; developer: string | null; website: string | null; gitcode: string | null; github: string | null }
