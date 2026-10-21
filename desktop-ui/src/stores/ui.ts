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
}

export const useUi = create<UiState>((set) => ({
  theme: 'system', setTheme: (theme) => set({ theme }),
  selectedPlugin: null, selectPlugin: (selectedPlugin) => set({ selectedPlugin }),
  approval: 'pending', decideApproval: (approval) => set({ approval }),
  activityExpanded: false, setActivityExpanded: (activityExpanded) => set({ activityExpanded })
}));
