import type {Approval, ApprovalRepository, ApprovalStatus} from '../../domain/task';
import type {SqliteConnection, SqliteValue} from '../database/SqliteConnection';
import {serializeConnection} from '../database/serializeConnection';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier, iso} from '../../protocol/PairingProtocol';

type Row = Record<string, SqliteValue>;

function decode(row: Row): Approval {
  return {
    approvalId: identifier(row.approval_id),
    taskId: identifier(row.task_id),
    ...(row.execution_ref === null ? {} : {executionRef: JSON.parse(String(row.execution_ref))}),
    requestedBy: String(row.requested_by),
    capability: String(row.capability),
    scope: JSON.parse(String(row.scope)),
    ...(row.target === null ? {} : {target: String(row.target)}),
    risk: row.risk as Approval['risk'],
    reason: String(row.reason),
    expiresAt: iso(row.expires_at),
    status: row.status as ApprovalStatus,
    nonce: identifier(row.nonce),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class SqliteApprovalRepository implements ApprovalRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = serializeConnection(db);
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Approval storage operation failed');
    }
  }

  private async getRaw(db: SqliteConnection, approvalId: string): Promise<Approval> {
    const row = (await db.executeAsync('SELECT * FROM approvals WHERE approval_id=?', [approvalId])).results[0];
    if (!row) {
      throw new CetaError('storage_error', 'Approval not found');
    }
    return decode(row);
  }

  async create(value: Approval): Promise<Approval> {
    identifier(value.approvalId);
    identifier(value.taskId);
    identifier(value.nonce);
    iso(value.expiresAt);
    iso(value.createdAt);
    iso(value.updatedAt);
    return this.safe(async () => {
      await this.db.executeAsync(
        'INSERT INTO approvals(approval_id,task_id,execution_ref,requested_by,capability,scope,target,risk,reason,expires_at,status,nonce,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [value.approvalId, value.taskId, value.executionRef ? JSON.stringify(value.executionRef) : null, value.requestedBy, value.capability, JSON.stringify(value.scope), value.target ?? null, value.risk, value.reason, value.expiresAt, value.status, value.nonce, value.revision, value.createdAt, value.updatedAt],
      );
      return value;
    });
  }

  async get(approvalId: string): Promise<Approval> {
    identifier(approvalId);
    return this.safe(async () => {
      return this.getRaw(this.db, approvalId);
    });
  }

  async update(approvalId: string, status: ApprovalStatus, expectedRevision: number): Promise<Approval> {
    identifier(approvalId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new CetaError('sync_conflict', 'Invalid approval revision');
    }
    return this.safe(() => this.db.transaction(async tx => {
      const current = await this.getRaw(tx, approvalId);
      if (current.revision !== expectedRevision) {
        throw new CetaError('sync_conflict', 'Approval revision is stale');
      }
      await tx.executeAsync('UPDATE approvals SET status=?,revision=?,updated_at=? WHERE approval_id=? AND revision=?', [status, expectedRevision + 1, new Date().toISOString(), approvalId, expectedRevision]);
      return this.getRaw(tx, approvalId);
    }));
  }

  listPending(taskId?: string): Promise<Approval[]> {
    if (taskId) {
      identifier(taskId);
    }
    return this.safe(async () => {
      const result = taskId
        ? await this.db.executeAsync('SELECT * FROM approvals WHERE task_id=? AND status=? ORDER BY updated_at,approval_id', [taskId, 'pending'])
        : await this.db.executeAsync('SELECT * FROM approvals WHERE status=? ORDER BY updated_at,approval_id', ['pending']);
      return result.results.map(decode);
    });
  }
}
