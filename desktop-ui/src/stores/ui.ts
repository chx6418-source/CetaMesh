import { create } from 'zustand';
import type { SkillReference } from '../bridge/typed-client';
import { readAppearance, writeAppearance, type AppearancePreferences } from '../theme/appearance';

export type ThemeMode = 'system' | 'light' | 'dark';
export interface ChatViewport { atBottom: boolean; anchor: {key: string; offset: number} | null }

type ApprovalChoice = 'pending' | 'approved' | 'denied';

interface UiState {
  appearance: AppearancePreferences;
  setAppearance(value: Partial<AppearancePreferences>): void;
  theme: ThemeMode;
  setTheme(theme: ThemeMode): void;
  selectedPlugin: string | null;
  selectPlugin(id: string | null): void;
  approval: ApprovalChoice;
  decideApproval(choice: ApprovalChoice): void;
  activityExpanded: boolean;
  setActivityExpanded(expanded: boolean): void;
  chatViewports: Record<string, ChatViewport>;
  saveChatViewport(sessionId: string, viewport: ChatViewport): void;
  chatDrafts: Record<string, string>;
  setChatDraft(sessionId: string, value: string | ((current: string) => string)): void;
  chatSkillRefs: Record<string, SkillReference[]>;
  setChatSkillRefs(sessionId: string, value: SkillReference[] | ((current: SkillReference[]) => SkillReference[])): void;
}

export const useUi = create<UiState>((set, get) => ({
  appearance: readAppearance(),
  setAppearance: value => { const appearance = writeAppearance({ ...get().appearance, ...value }); set({ appearance }); },
  theme: 'system', setTheme: (theme) => set({ theme }),
  selectedPlugin: null, selectPlugin: (selectedPlugin) => set({ selectedPlugin }),
  approval: 'pending', decideApproval: (approval) => set({ approval }),
  activityExpanded: false, setActivityExpanded: (activityExpanded) => set({ activityExpanded }),
  // Ephemeral editor state only: no IPC, localStorage or long-term Memory write.
  chatViewports: {},
  saveChatViewport: (sessionId, viewport) => set(state => {
    if (!sessionId || (!viewport.atBottom && !viewport.anchor)) return state;
    const chatViewports = { ...state.chatViewports };
    delete chatViewports[sessionId];
    chatViewports[sessionId] = viewport;
    const oldest = Object.keys(chatViewports)[0];
    if (Object.keys(chatViewports).length > 100) delete chatViewports[oldest];
    return { chatViewports };
  }),
  chatDrafts: {},
  chatSkillRefs: {},
  setChatSkillRefs: (sessionId, value) => set(state => {
    if (!sessionId) return state;
    const current = state.chatSkillRefs[sessionId] ?? [];
    const next = typeof value === 'function' ? value(current) : value;
    const chatSkillRefs = { ...state.chatSkillRefs };
    if (next.length) chatSkillRefs[sessionId] = next.slice(0, 16).map(({skillId,sourceRevision,sourceKind}) => ({skillId,sourceRevision,sourceKind}));
    else delete chatSkillRefs[sessionId];
    return { chatSkillRefs };
  }),
  setChatDraft: (sessionId, value) => set(state => {
    if (!sessionId) return state;
    const next = typeof value === 'function' ? value(state.chatDrafts[sessionId] ?? '') : value;
    if (next === (state.chatDrafts[sessionId] ?? '')) return state;
    const chatDrafts = { ...state.chatDrafts };
    if (next) chatDrafts[sessionId] = next; else delete chatDrafts[sessionId];
    return { chatDrafts };
  })
}));
