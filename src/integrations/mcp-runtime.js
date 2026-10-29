// MCP Runtime: supervise built-in stdio servers through the official SDK transport.
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_PATHS, isPackagedRuntime } from '../app-paths.js';
import { redactObject, redactText } from '../logging/redact.js';
import { MCP_SERVER_CATALOG } from './catalog.js';
import { integrationError } from './types.js';
import { createRemoteMcpConnection } from './mcp-remote.js';
import { validateSchema } from '../model/input-schema.js';

const PACKAGED_MCP_MODES = Object.freeze({
  snowluma: 'snowluma',
  'snowluma-host': 'snowluma-host',
  'web-search-safe': 'web-search-safe',
  'qq-file-send': 'qq-file-send',
  bilibili: 'bilibili'
});
const MCP_RUNTIME_ENV_KEYS = Object.freeze(['WHALEBRIDGE_DATA_DIR', 'WHALEBRIDGE_RESOURCE_DIR']);
const STDERR_TAIL_LIMIT = 6000;

function safePath(value, env = process.env) {
  let result = path.resolve(String(value ?? ''));
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE']) {
    const root = String(env[key] ?? '').trim();
    if (root) result = result.replaceAll(root, `%${key}%`);
  }
  const home = os.homedir();
  if (home) result = result.replaceAll(home, '%USERPROFILE%');
  return result;
}

function minimalMcpEnvironment(configEnv = {}, sourceEnv = process.env) {
  const env = {};
  for (const key of MCP_RUNTIME_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  if (configEnv && typeof configEnv === 'object' && !Array.isArray(configEnv)) {
    for (const [key, value] of Object.entries(configEnv)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') env[key] = value;
    }
  }
  return env;
}

/** Resolve one source or packaged launch without relying on the process cwd. */
export function resolveMcpLaunch(server, config = {}, {
  packaged = isPackagedRuntime(), execPath = process.execPath,
  sourceRoot = APP_PATHS.sourceRoot, env = process.env
} = {}) {
  if (!server?.id || !server?.entry) throw integrationError('MCP_UNSUPPORTED_TRANSPORT', 'MCP Server 缺少有效入口。');
  const executable = path.resolve(execPath);
  const root = path.resolve(sourceRoot);
  const cwd = path.resolve(config.cwd || (packaged ? path.dirname(executable) : root));
  if (packaged) {
    const mode = PACKAGED_MCP_MODES[server.id];
    if (!mode) throw integrationError('MCP_UNSUPPORTED_TRANSPORT', '打包版不支持此 MCP Server 入口。');
    return {
      command: executable,
      args: ['--mcp', mode, ...(Array.isArray(config.args) ? config.args.map(String) : [])],
      cwd,
      resolvedEntry: `packaged-mcp:${mode}`,
      resolvedExecutable: safePath(executable, env),
      resolvedCwd: safePath(cwd, env),
      packaged: true
    };
  }
  const entry = path.resolve(root, server.entry);
  return {
    command: executable,
    args: [entry, ...(Array.isArray(config.args) ? config.args.map(String) : [])],
    cwd,
    resolvedEntry: safePath(entry, env),
    resolvedExecutable: safePath(executable, env),
    resolvedCwd: safePath(cwd, env),
    packaged: false
  };
}

function diagnostic(log, record) {
  try { log('[mcp-diagnostic] ' + JSON.stringify(redactObject(record))); }
  catch (logError) { void logError; /* Diagnostic logging must never stop a tool or child process. */ }
}

/** Start via the SDK stdio framing and wait for the protocol initialize handshake. */
export async function createStdioMcpConnection(server, config = {}, {
  packaged = isPackagedRuntime(), execPath = process.execPath,
  sourceRoot = APP_PATHS.sourceRoot, env = process.env, log = () => {}
} = {}) {
  const launch = resolveMcpLaunch(server, config, { packaged, execPath, sourceRoot, env });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: {
      ...minimalMcpEnvironment(config.env, env),
      WHALEBRIDGE_DATA_DIR: config.env?.WHALEBRIDGE_DATA_DIR ?? env.WHALEBRIDGE_DATA_DIR ?? APP_PATHS.dataRoot,
      WHALEBRIDGE_RESOURCE_DIR: config.env?.WHALEBRIDGE_RESOURCE_DIR ?? env.WHALEBRIDGE_RESOURCE_DIR
        ?? (launch.packaged ? path.join(path.dirname(launch.command), 'resources') : sourceRoot)
    },
    cwd: launch.cwd,
    stderr: 'pipe'
  });
  let closeHandler = null;
  let closed = false;
  let phase = 'spawn';
  let exitCode = null;
  let signal = null;
  let stderrTail = '';
  const logPhase = (nextPhase, extra = {}) => diagnostic(log, {
    serverId: server.id, phase: nextPhase,
    resolvedExecutable: launch.resolvedExecutable,
    resolvedEntry: launch.resolvedEntry,
    cwd: launch.resolvedCwd,
    exitCode, signal,
    stderrTail: redactText(stderrTail.slice(-STDERR_TAIL_LIMIT)),
    ...extra
  });

  transport.stderr?.on('data', chunk => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT);
  });
  // Attach lifecycle listeners before connect() calls transport.start().
  transport.onclose = () => {
    closed = true;
    const child = transport._process;
    // The SDK clears _process before onclose; exit metadata is captured from its close event below.
    if (child) { exitCode = child.exitCode; signal = child.signalCode; }
    logPhase('child-exit');
    closeHandler?.(null);
  };
  transport.onerror = error => {
    logPhase(phase, { error: redactText(error?.message ?? error) });
    closeHandler?.(error);
  };
  const originalStart = transport.start.bind(transport);
  transport.start = async () => {
    logPhase('spawn');
    await originalStart();
    const child = transport._process;
    child?.once('exit', (code, childSignal) => {
      exitCode = code;
      signal = childSignal;
    });
    child?.once('close', (code, childSignal) => {
      exitCode = code;
      signal = childSignal;
    });
  };

  const client = new Client({ name: 'cetamesh-mcp-runtime', version: '1.0.0' });
  try {
    phase = 'initialize';
    await client.connect(transport);
    logPhase('initialized', { pid: transport.pid ?? null });
  } catch (error) {
    phase = 'initialize';
    logPhase('startup-failed', { error: redactText(error?.message ?? error) });
    try { await transport.close(); } catch (cleanupError) { void cleanupError; /* Startup cleanup is best effort; diagnostics hold the cause. */ }
    throw integrationError('MCP_START_FAILED', 'MCP Server initialize 失败，请查看本机脱敏诊断日志。');
  }

  return {
    pid: transport.pid ?? null,
    onClose(handler) {
      closeHandler = handler;
      if (closed) handler?.(null);
    },
    async listTools() {
      phase = 'tools/list';
      logPhase(phase);
      const result = await client.listTools();
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    async callTool(name, args) {
      phase = 'tool/call';
      logPhase(phase, { toolName: String(name) });
      return client.callTool({ name, arguments: args ?? {} });
    },
    async close() {
      phase = 'shutdown';
      logPhase(phase);
      closeHandler = null;
      try { await client.close(); } catch (error) {
        logPhase('shutdown-failed', { error: redactText(error?.message ?? error) });
      }
    }
  };
}

function normalizeTool(tool) {
  return {
    name: String(tool?.name ?? ''),
    description: String(tool?.description ?? ''),
    inputSchema: tool?.inputSchema ?? { type: 'object' },
    discovered: true
  };
}

export function createMcpRuntime({
  servers = MCP_SERVER_CATALOG,
  transportFactory = null,
  resolveCredential = null, networkOptions = {},
  now = () => Date.now(),
  log = () => {}
} = {}) {
  const serverById = new Map(servers.map(server => [server.id, server]));
  const records = new Map();

  function recordFor(id) {
    if (!records.has(id)) records.set(id, {
      status: 'stopped', lastError: null, pid: null, startedAt: null,
      restarts: 0, crashes: 0, tools: [], connection: null, stopping: false,
      generation: 0, startPromise: null
    });
    return records.get(id);
  }
  function requireServer(id) {
    const server = serverById.get(String(id));
    if (!server) throw integrationError('UNKNOWN_MCP_SERVER', '未知 MCP Server：' + id);
    return server;
  }
  function snapshot(id) {
    const record = recordFor(id);
    return { id, status: record.status, lastError: record.lastError, pid: record.pid,
      startedAt: record.startedAt, restarts: record.restarts, crashes: record.crashes,
      tools: record.tools.map(tool => ({ ...tool })) };
  }
  function handleClose(id, error) {
    const record = records.get(id);
    if (!record || record.status === 'crashed') return;
    record.connection = null;
    record.pid = null;
    record.tools = [];
    if (record.stopping) { record.status = 'stopped'; record.lastError = null; return; }
    record.status = 'crashed';
    record.crashes += 1;
    record.lastError = 'MCP Server 连接意外关闭，请查看本机脱敏诊断日志。';
    try { log('[mcp-diagnostic] ' + JSON.stringify(redactObject({ serverId: id, phase: 'runtime-closed', error: error?.message ?? null }))); }
    catch (logError) { void logError; /* A logging failure cannot change the MCP state. */ }
  }
  function start(id, config = {}) {
    const server = requireServer(id);
    const record = recordFor(id);
    if (record.status === 'running') return Promise.resolve(snapshot(id));
    if (record.status === 'starting') return record.startPromise;
    const generation = ++record.generation;
    record.status = 'starting'; record.lastError = null; record.stopping = false;
    record.tools = [];
    const operation = startConnection();
    record.startPromise = operation;
    return operation;

    async function startConnection() {
      let connection = null;
      try {
        connection = await (transportFactory ?? (server.transport === 'streamable-http' ? createRemoteMcpConnection : createStdioMcpConnection))(server, config, { log, resolveCredential, networkOptions });
        if (generation !== record.generation) throw integrationError('MCP_START_CANCELLED', 'MCP Server 启动已取消。');
        record.connection = connection;
        record.pid = connection.pid ?? null;
        connection.onClose?.(error => {
          if (record.generation === generation && record.connection === connection) handleClose(id, error);
        });
        if (record.status === 'crashed') throw integrationError('MCP_CHILD_CLOSED', 'MCP child exited during startup.');
        const discovered = typeof connection.listTools === 'function' ? await connection.listTools() : [];
        if (generation !== record.generation) throw integrationError('MCP_START_CANCELLED', 'MCP Server 启动已取消。');
        if (record.status === 'crashed') throw integrationError('MCP_CHILD_CLOSED', 'MCP child exited during initialization.');
        record.tools = discovered.map(normalizeTool).filter(tool => tool.name);
        record.status = 'running';
        record.startedAt = now();
        return snapshot(id);
      } catch (error) {
        if (generation !== record.generation) {
          try { await connection?.close?.(); } catch (cleanupError) { void cleanupError; /* A cancelled startup still owns and closes its late child. */ }
          throw integrationError('MCP_START_CANCELLED', 'MCP Server 启动已取消。');
        }
        const alreadyCrashed = record.status === 'crashed';
        record.connection = null;
        record.pid = null;
        record.status = 'crashed';
        if (!alreadyCrashed) record.crashes += 1;
        record.lastError = 'MCP Server 启动失败，请查看本机脱敏诊断日志。';
        try { log('[mcp-diagnostic] ' + JSON.stringify(redactObject({ serverId: id, phase: 'startup-failed', error: error?.message ?? String(error) }))); }
        catch (logError) { void logError; /* Startup failure remains observable through a stable status and error code. */ }
        try { await connection?.close?.(); } catch (cleanupError) { void cleanupError; /* Child cleanup is best effort after a protocol failure. */ }
        throw integrationError('MCP_START_FAILED', record.lastError);
      } finally {
        if (generation === record.generation) record.startPromise = null;
      }
    }
  }
  async function stop(id) {
    requireServer(id);
    const record = recordFor(id);
    const generation = ++record.generation;
    record.startPromise = null;
    record.tools = [];
    if (!record.connection) {
      if (record.status !== 'crashed') record.status = 'stopped';
      if (record.status !== 'crashed') record.lastError = null;
      record.pid = null;
      return snapshot(id);
    }
    record.stopping = true; record.status = 'stopping';
    const connection = record.connection;
    record.connection = null;
    try { await connection.close(); }
    catch (error) { record.lastError = 'MCP Server 关闭失败，请查看本机脱敏诊断日志。'; try { log('[mcp-diagnostic] ' + JSON.stringify(redactObject({ serverId: id, phase: 'shutdown-failed', error: error?.message ?? String(error) }))); } catch (logError) { void logError; /* Preserve cleanup state when logging fails. */ } }
    if (generation !== record.generation) return snapshot(id);
    record.status = 'stopped'; record.pid = null; record.stopping = false;
    return snapshot(id);
  }
  async function restart(id, config = {}) {
    requireServer(id); await stop(id);
    const record = recordFor(id); record.restarts += 1; record.lastError = null;
    return start(id, config);
  }
  function discover(id) {
    const server = requireServer(id); const record = recordFor(id);
    if (record.status === 'running') return record.tools.map(tool => ({ ...tool, discovered: true }));
    return server.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: { type: 'object' }, discovered: false }));
  }
  async function call(id, toolName, args = {}, options = {}) {
    const server = requireServer(id); const record = recordFor(id);
    if (server.transport !== 'streamable-http' && !server.tools.some(tool => tool.name === toolName)) throw integrationError('UNKNOWN_MCP_TOOL', '未知 MCP 工具：' + server.namespace + toolName);
    if (record.status !== 'running' || !record.connection) throw integrationError('PROVIDER_UNAVAILABLE', 'MCP Server ' + id + ' 未运行（' + record.status + '）');
    if (!record.tools.some(tool => tool.name === toolName)) throw integrationError('UNKNOWN_MCP_TOOL', 'MCP Server ' + id + ' 未暴露工具：' + toolName);
    const tool=record.tools.find(tool => tool.name === toolName);
    if(server.transport==='streamable-http')validateSchema(tool.inputSchema,args);
    try { return await record.connection.callTool(toolName, args, options); }
    catch (error) {
      record.lastError = 'MCP 工具调用失败，请查看本机脱敏诊断日志。';
      try { log('[mcp-diagnostic] ' + JSON.stringify(redactObject({ serverId: id, phase: 'tool/call-failed', toolName, error: error?.message ?? String(error) }))); }
      catch (logError) { void logError; /* Keep the safe error visible when diagnostic output fails. */ }
      const safeError=error?.code ? integrationError(error.code, record.lastError) : integrationError('MCP_CALL_FAILED', record.lastError);
      if(error?.effectStatus==='unknown')safeError.effectStatus='unknown';
      throw safeError;
    }
  }
  function status(id) { requireServer(id); return snapshot(id); }
  function list() { return servers.map(server => snapshot(server.id)); }
  async function closeAll() {
    for (const server of servers) if (records.get(server.id)?.connection || records.get(server.id)?.status === 'starting') await stop(server.id);
  }
  return { list, status, start, stop, restart, discover, call, snapshot, closeAll, recordFor };
}
