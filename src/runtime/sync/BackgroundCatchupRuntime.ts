import type {OfflineInboxRuntime} from '../inbox/OfflineInboxRuntime';
import type {SyncQueueRuntime} from './SyncQueueRuntime';

export type BackgroundCatchupOptions = {readonly maxWork?: number; readonly now?: () => number};
export type BackgroundCatchupResult = {readonly processed: number; readonly bounded: true};

export class BackgroundCatchupRuntime {
  private readonly maxWork: number;
  constructor(
    private readonly queue: SyncQueueRuntime,
    private readonly inbox: OfflineInboxRuntime,
    options: BackgroundCatchupOptions = {},
  ) {
    this.maxWork = Number.isInteger(options.maxWork) && Number(options.maxWork) >= 0 ? Math.min(Number(options.maxWork), 20) : 10;
  }

  async resume(): Promise<BackgroundCatchupResult> {
    if (this.maxWork === 0) { return {processed: 0, bounded: true}; }
    const recoveredQueue = await this.queue.recoverInterrupted();
    const recoveredInbox = await this.inbox.recoverInterrupted();
    return {processed: Math.min(this.maxWork, recoveredQueue + recoveredInbox || (recoveredQueue || recoveredInbox ? 1 : 0)), bounded: true};
  }
}
