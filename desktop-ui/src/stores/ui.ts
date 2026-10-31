import { create } from 'zustand';

export type ThemeMode = 'system' | 'light' | 'dark';
type ApprovalChoice = 'pending' | 'approved' | 'denied';

interface UiState {
  theme: ThemeMode;
  setTheme(theme: ThemeMode): void;
  selectedPlugin: string | null;
  selectPlugin(id: string | null): void;
  approval: ApprovalChoice;
  decideApproval(choice: ApprovalChoice): void;
  activityExpanded: boolean;
  setActivityExpanded(expanded: boolean): void;
  chatDrafts: Record<string, string>;
  setChatDraft(sessionId: string, value: string | ((current: string) => string)): void;
}

export const useUi = create<UiState>((set) => ({
  theme: 'system', setTheme: (theme) => set({ theme }),
  selectedPlugin: null, selectPlugin: (selectedPlugin) => set({ selectedPlugin }),
  approval: 'pending', decideApproval: (approval) => set({ approval }),
  activityExpanded: false, setActivityExpanded: (activityExpanded) => set({ activityExpanded }),
  // Ephemeral editor state only: no IPC, localStorage or long-term Memory write.
  chatDrafts: {},
  setChatDraft: (sessionId, value) => set(state => {
    if (!sessionId) return state;
    const next = typeof value === 'function' ? value(state.chatDrafts[sessionId] ?? '') : value;
    if (next === (state.chatDrafts[sessionId] ?? '')) return state;
    const chatDrafts = { ...state.chatDrafts };
    if (next) chatDrafts[sessionId] = next; else delete chatDrafts[sessionId];
    return { chatDrafts };
  })
}));
