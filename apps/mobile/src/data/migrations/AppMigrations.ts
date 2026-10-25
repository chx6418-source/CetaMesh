import type { Migration } from './Migration';

// M0 version 0 is retained; M1 adds only standalone chat metadata and history.
export const appMigrations: readonly Migration[] = [
  {
    version: 1,
    statements: [
      'CREATE TABLE model_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, credential_ref TEXT NOT NULL, supports_reasoning INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
      "CREATE TABLE chat_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES chat_sessions(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('streaming','completed','failed','cancelled')), reply_to TEXT, error_code TEXT, created_at TEXT NOT NULL)",
      'CREATE INDEX messages_session_sequence ON chat_messages(session_id,sequence)',
      "CREATE UNIQUE INDEX one_stream_per_session ON chat_messages(session_id) WHERE status='streaming'",
      'CREATE INDEX sessions_updated ON chat_sessions(archived,updated_at,id)',
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('working','chat','user','task','local')),
        scope TEXT NOT NULL DEFAULT 'local-only' CHECK(scope='local-only'),
        content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 16000),
        source TEXT NOT NULL DEFAULT '{"kind":"manual"}',
        source_session_id TEXT,
        importance REAL NOT NULL DEFAULT 0.5 CHECK(importance BETWEEN 0 AND 1),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      )`,
      'CREATE INDEX memories_kind_updated ON memories(kind,updated_at,id)',
      'CREATE INDEX memories_source_session ON memories(source_session_id)',
    ],
  },
  {
    version: 3,
    statements: [
      'CREATE TABLE device_trust (device_id TEXT PRIMARY KEY, device_name TEXT NOT NULL, public_key TEXT NOT NULL, endpoint TEXT NOT NULL, local_device_id TEXT NOT NULL, local_public_key TEXT NOT NULL, created_at TEXT NOT NULL)',
      'CREATE TABLE pairing_used (peer_id TEXT NOT NULL, invitation_id TEXT NOT NULL, expires_at TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), PRIMARY KEY(peer_id,invitation_id))',
    ],
  },
  {
    version: 4,
    statements: [
      "ALTER TABLE device_trust ADD COLUMN trust_state TEXT NOT NULL DEFAULT 'trusted'",
      "ALTER TABLE device_trust ADD COLUMN transport_type TEXT NOT NULL DEFAULT 'unknown'",
      'ALTER TABLE device_trust ADD COLUMN paired_at TEXT',
      'ALTER TABLE device_trust ADD COLUMN last_seen_at TEXT',
      "ALTER TABLE device_trust ADD COLUMN peer_role TEXT NOT NULL DEFAULT 'desktop-node'",
      'ALTER TABLE device_trust ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE device_trust ADD COLUMN capability_manifest_version INTEGER NOT NULL DEFAULT 1',
      "ALTER TABLE device_trust ADD COLUMN capability_count INTEGER NOT NULL DEFAULT 0",
      'ALTER TABLE device_trust ADD COLUMN last_error_code TEXT',
    ],
  },
  {
    version: 5,
    statements: [
      `CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL CHECK(length(trim(goal)) BETWEEN 1 AND 4000),
        status TEXT NOT NULL CHECK(status IN ('queued','running','blocked','paused','completed','failed','cancelled')),
        phase TEXT NOT NULL CHECK(length(trim(phase)) BETWEEN 1 AND 100),
        progress REAL NOT NULL CHECK(progress BETWEEN 0 AND 1),
        source TEXT NOT NULL CHECK(source IN ('mobile','desktop-node','server-node','sync','user')),
        workspace_ref TEXT,
        provider_execution_ref TEXT,
        checkpoint_ref TEXT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX tasks_updated ON tasks(updated_at DESC,task_id DESC)',
      `CREATE TABLE task_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        payload TEXT NOT NULL CHECK(length(payload) <= 65536),
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX task_events_task_created ON task_events(task_id,created_at,event_id)',
      `CREATE TABLE task_attention (
        attention_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('question.required','approval.required','task.blocked','agent.needs_attention')),
        title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
        summary TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','resolved')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX task_attention_pending ON task_attention(status,updated_at,task_id)',
      `CREATE TABLE approvals (
        approval_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        execution_ref TEXT,
        requested_by TEXT NOT NULL CHECK(length(trim(requested_by)) BETWEEN 1 AND 200),
        capability TEXT NOT NULL CHECK(length(trim(capability)) BETWEEN 1 AND 96),
        scope TEXT NOT NULL,
        target TEXT,
        risk TEXT NOT NULL CHECK(risk IN ('low','medium','high','critical')),
        reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','cancelled','consumed')),
        nonce TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX approvals_task_status ON approvals(task_id,status,updated_at)',
    ],
  },
  {
    version: 6,
    statements: [
      `CREATE TABLE sync_queue (
        event_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(length(trim(kind)) BETWEEN 1 AND 120),
        payload TEXT NOT NULL CHECK(length(payload) <= 65536),
        status TEXT NOT NULL CHECK(status IN ('pending','sending','acked','failed','dead-letter')),
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX sync_queue_ready ON sync_queue(status,next_attempt_at,created_at,event_id)',
    ],
  },
  {
    version: 7,
    statements: [
      `CREATE TABLE mesh_memory_sync (
        memory_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK(scope_type='my-devices'),
        scope_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        source TEXT NOT NULL,
        policy TEXT NOT NULL CHECK(policy='my-devices'),
        content TEXT,
        deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX mesh_memory_sync_scope ON mesh_memory_sync(owner_id,scope_id,updated_at)',
    ],
  },
  {
    version: 8,
    statements: [
      `CREATE TABLE mesh_task_sync (
        task_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK(scope_type='my-devices'),
        scope_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        snapshot TEXT NOT NULL CHECK(length(snapshot) <= 65536),
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX mesh_task_sync_scope ON mesh_task_sync(owner_id,scope_id,updated_at)',
    ],
  },
  {
    version: 9,
    statements: [
      `CREATE TABLE mobile_inbox (
        inbox_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('share','quick-memory','voice','task-note')),
        payload TEXT NOT NULL CHECK(length(payload) <= 65536),
        status TEXT NOT NULL CHECK(status IN ('pending','processing','failed','completed')),
        local_only INTEGER NOT NULL CHECK(local_only=1),
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX mobile_inbox_status ON mobile_inbox(status,updated_at,inbox_id)',
    ],
  },
  {
    version: 10,
    statements: [
      `CREATE TABLE extensions (
        extension_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('base','user-overlay','import')),
        manifest TEXT NOT NULL CHECK(length(manifest) <= 131072),
        content_hash TEXT NOT NULL CHECK(length(content_hash) <= 64),
        status TEXT NOT NULL CHECK(status IN ('installed','enabled','disabled')),
        security_report TEXT NOT NULL CHECK(length(security_report) <= 131072),
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        previous_manifest TEXT,
        previous_content_hash TEXT,
        PRIMARY KEY(extension_id, source)
      )`,
      'CREATE INDEX extensions_updated ON extensions(updated_at DESC,extension_id,source)',
    ],
  },
  {
    version: 11,
    statements: [
      'CREATE TABLE mobile_preferences (id INTEGER PRIMARY KEY CHECK(id=1), new_chat_defaults TEXT NOT NULL CHECK(length(new_chat_defaults) <= 2048))',
    ],
  },
  {
    version: 12,
    statements: [
      `CREATE TABLE chat_turn_usage (
        assistant_message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
        total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0),
        cached_input_tokens INTEGER,
        cache_miss_input_tokens INTEGER,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX chat_turn_usage_session ON chat_turn_usage(session_id,created_at)',
    ],
  },
];
