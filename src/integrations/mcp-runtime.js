// MCP Runtime：统一 MCP Server 生命周期（start / stop / restart / status / tools / call）。
//
// "接上已有 runtime，不要重写"：MCP Server 进程仍然是仓库里既有的
// src/mcp-*.js（stdio MCP Server），本模块只做**统一的注册表与监督**，
// 复用官方 @modelcontextprotocol/sdk 的 Client/StdioClientTransport，
// 不另造一套 MCP 协议实现。transportFactory 可注入，便于测试与后续替换传输。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_SERVER_CATALOG } from './catalog.js';
import { integrationError } from './types.js';

const PROCESS_EXECUTABLE = process.execPath;

/** 默认传输：spawn 仓库内既有 MCP Server 入口（stdio）+ 官方 SDK Client。 */
export async function createStdioMcpConnection(server, config = {}) {
  if (!server?.entry) throw integrationError('MCP_UNSUPPORTED_TRANSPORT', 'MCP Server 没有可用的 stdio 入口：' + server?.id);
  const transport = new StdioClientTransport({
    command: PROCESS_EXECUTABLE,
    args: [server.entry, ...(Array.isArray(config.args) ? config.args : [])],
    env: { ...process.env, ...(config.env ?? {}) },
    ...(config.cwd ? { cwd: config.cwd } : {}),
    stderr: 'pipe'
  });
  const client = new Client({ name: 'cetamesh-mcp-runtime', version: '1.0.0' });
  await client.connect(transport);
  let closeHandler = null;
  transport.onclose = () => { closeHandler?.(null); };
  transport.onerror = error => { closeHandler?.(error); };
  return {
    pid: transport.pid ?? null,
    onClose(handler) { closeHandler = handler; },
    async listTools() {
      const result = await client.listTools();
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    async callTool(name, args) {
      return client.callTool({ name, arguments: args ?? {} });
    },
    async close() {
      closeHandler = null;
      try { await client.close(); } catch (error) {
        // 关闭失败不影响状态机：连接已不可用，按已停止处理。
        void error;
      }
    }
  };
}

function normalizeTool(tool) {
  return {
    name: String(tool?.name ?? ''),
    description: String(tool?.description ?? ''),
    inputSchema: tool?.inputSchema ?? { type: 'object' },
    // discovered=true 表示这条来自 MCP Server 真实 listTools，而非目录声明。
    discovered: true
  };
}

export function createMcpRuntime({
  servers = MCP_SERVER_CATALOG,
  transportFactory = createStdioMcpConnection,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  const serverById = new Map(servers.map(server => [server.id, server]));
  const records = new Map();

  function recordFor(id) {
    if (!records.has(id)) {
      records.set(id, {
        status: 'stopped', lastError: null, pid: null, startedAt: null,
        restarts: 0, crashes: 0, tools: [], connection: null, stopping: false
      });
    }
    return records.get(id);
  }

  function requireServer(id) {
    const server = serverById.get(String(id));
    if (!server) throw integrationError('UNKNOWN_MCP_SERVER', '未知 MCP Server：' + id);
    return server;
  }

  function snapshot(id) {
    const record = recordFor(id);
    return {
      id, status: record.status, lastError: record.lastError, pid: record.pid,
      startedAt: record.startedAt, restarts: record.restarts, crashes: record.crashes,
      tools: record.tools.map(tool => ({ ...tool }))
    };
  }

  function handleClose(id, error) {
    const record = records.get(id);
    if (!record) return;
    record.connection = null;
    record.pid = null;
    if (record.stopping) {
      record.status = 'stopped';
      record.lastError = null;
      return;
    }
    record.status = 'crashed';
    record.crashes += 1;
    record.lastError = error ? String(error?.message ?? error) : 'MCP Server 连接意外关闭';
    log('MCP Server ' + id + ' 异常退出：' + record.lastError);
  }

  async function start(id, config = {}) {
    const server = requireServer(id);
    const record = recordFor(id);
    if (record.status === 'running' || record.status === 'starting') return snapshot(id);
    record.status = 'starting';
    record.lastError = null;
    record.stopping = false;
    try {
      const connection = await transportFactory(server, config);
      record.connection = connection;
      record.pid = connection.pid ?? null;
      const discovered = typeof connection.listTools === 'function' ? await connection.listTools() : [];
      record.tools = discovered.map(normalizeTool).filter(tool => tool.name);
      record.status = 'running';
      record.startedAt = now();
      connection.onClose?.(error => handleClose(id, error));
      return snapshot(id);
    } catch (error) {
      record.connection = null;
      record.pid = null;
      record.status = 'crashed';
      record.crashes += 1;
      record.lastError = String(error?.message ?? error);
      throw integrationError('MCP_START_FAILED', 'MCP Server ' + id + ' 启动失败：' + record.lastError);
    }
  }

  async function stop(id) {
    requireServer(id);
    const record = recordFor(id);
    if (!record.connection) {
      record.status = record.status === 'running' ? 'stopped' : record.status;
      record.lastError = record.status === 'crashed' ? record.lastError : null;
      record.pid = null;
      return snapshot(id);
    }
    record.stopping = true;
    record.status = 'stopping';
    const connection = record.connection;
    record.connection = null;
    try {
      await connection.close();
    } catch (error) {
      // 关闭异常仍按已停止记录，但保留 lastError 供 UI 说明。
      record.lastError = String(error?.message ?? error);
    }
    record.status = 'stopped';
    record.pid = null;
    record.stopping = false;
    return snapshot(id);
  }

  async function restart(id, config = {}) {
    requireServer(id);
    await stop(id);
    const record = recordFor(id);
    record.restarts += 1;
    record.lastError = null;
    return start(id, config);
  }

  /** 工具发现：运行中返回真实 listTools 结果；否则回退到目录声明（available 由 Registry 决定）。 */
  function discover(id) {
    const server = requireServer(id);
    const record = recordFor(id);
    if (record.status === 'running' && record.tools.length) {
      return record.tools.map(tool => ({ ...tool, discovered: true }));
    }
    return server.tools.map(tool => ({
      name: tool.name, description: tool.description, inputSchema: { type: 'object' }, discovered: false
    }));
  }

  async function call(id, toolName, args = {}) {
    const server = requireServer(id);
    const record = recordFor(id);
    const known = server.tools.some(tool => tool.name === toolName);
    if (!known) throw integrationError('UNKNOWN_MCP_TOOL', '未知 MCP 工具：' + server.namespace + toolName);
    if (record.status !== 'running' || !record.connection) {
      throw integrationError('PROVIDER_UNAVAILABLE', 'MCP Server ' + id + ' 未运行（' + record.status + '）');
    }
    if (record.tools.length && !record.tools.some(tool => tool.name === toolName)) {
      throw integrationError('UNKNOWN_MCP_TOOL', 'MCP Server ' + id + ' 未暴露工具：' + toolName);
    }
    try {
      return await record.connection.callTool(toolName, args);
    } catch (error) {
      record.lastError = String(error?.message ?? error);
      throw error?.code ? error : integrationError('MCP_CALL_FAILED', record.lastError);
    }
  }

  function status(id) {
    requireServer(id);
    return snapshot(id);
  }

  function list() {
    return servers.map(server => snapshot(server.id));
  }

  async function closeAll() {
    for (const server of servers) {
      const record = records.get(server.id);
      if (record?.connection) await stop(server.id);
    }
  }

  return { list, status, start, stop, restart, discover, call, snapshot, closeAll, recordFor };
}
