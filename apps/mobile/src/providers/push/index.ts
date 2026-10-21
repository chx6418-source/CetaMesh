export type {PushAttentionPayload, PushEventKind} from '../../domain/task/PushAttention';

export interface PushProviderPort {
  register(handler: (payload: unknown) => void): () => void;
}
