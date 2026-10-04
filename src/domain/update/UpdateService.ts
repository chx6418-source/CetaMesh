export type UpdateAnnouncement = {
  version: string;
  title: string;
  publishedAt: string;
  content: string;
  importance: 'feature' | 'fix' | 'security' | 'important';
};

export type UpdateCheck = {status: 'available'; version: string} | {status: 'current'} | {status: 'unavailable'} | {status: 'unconfigured'};

export interface UpdateService {
  checkForUpdate(): Promise<UpdateCheck>;
  getLatestVersion(): Promise<string | undefined>;
  getReleaseNotes(): Promise<UpdateAnnouncement[]>;
  downloadUpdate(): Promise<string | undefined>;
}

// Private beta has no authenticated release feed yet. Never embed a GitHub token in the APK.
export const unconfiguredUpdateService: UpdateService = {
  checkForUpdate: async () => ({status: 'unconfigured'}),
  getLatestVersion: async () => undefined,
  getReleaseNotes: async () => [],
  downloadUpdate: async () => undefined,
};
