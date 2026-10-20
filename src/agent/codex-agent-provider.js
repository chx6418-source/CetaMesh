import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliAgentProcess } from './cli-agent-process.js';
import { agentProviderError, defineAgentProvider } from './agent-provider.js';
import {
  cleanupStagingWorkspace,
  collectStagedChanges,
  createStagingWorkspace,
  refreshStagingBaseline
} from '../workspace/staging.js';

export const AGENT_EVENT_PROTOCOL_TURN_V1 = 'agent-turn-events-v1';
const PROFILE = 'cetamesh-task';
const CAPTURE_MAX = 2000;
const HEALTH_TTL_MS = 30_000;
const INHERITED_PROVIDER_FIELDS = Object.freeze(['name', 'base_url', 'wire_api', 'env_key', 'requires_openai_auth']);

function quoteToml(value) {
  return JSON.stringify(String(value));
}

function profileOverrides() {
  const key = `permissions.${PROFILE}`;
  const workspaceFileRules = [
    ['.', 'write'],
    ['**/.env', 'deny'],
    ['**/.env.*', 'deny']
  ].map(([pattern, access]) => `${quoteToml(pattern)}=${quoteToml(access)}`).join(',');
  const filesystemRules = [
    [':root', 'deny'],
    [':minimal', 'read'],
    [':tmpdir', 'deny'],
    [':slash_tmp', 'deny']
  ].map(([root, access]) => `${quoteToml(root)}=${quoteToml(access)}`);
  filesystemRules.push(`${quoteToml(':workspace_roots')}={${workspaceFileRules}}`);
  return [
    `default_permissions=${quoteToml(PROFILE)}`,
    `${key}.extends=":workspace"`,
    `${key}.filesystem={${filesystemRules.join(',')}}`,
    `${key}.network.enabled=false`
  ];
}

/** Provider-owned flags are derived from codex --help / exec --help / exec resume --help. */
export function buildCodexExecArgs({ stageRoot, promptMode = 'fresh', threadId = null, model, reasoningEffort, modelConfiguration, securityMode = 'native', windowsSandboxMode = 'unelevated' } = {}) {
  if (!['native', 'isolated'].includes(securityMode)) throw agentProviderError('INVALID_PARAMS', 'Unknown Agent security mode');
  const args = [
    '--ask-for-approval', 'never',
    '-C', path.resolve(stageRoot)
  ];
  if (model) args.push('--model', String(model));
  if (reasoningEffort) args.push('--config', `model_reasoning_effort=${quoteToml(reasoningEffort)}`);
  args.push(...inheritedProviderArgs(modelConfiguration));
  // Security-sensitive settings follow inherited model configuration so they always win.
  // The staging copy is a working directory, not host-file read isolation. It is already the command's -C workspace. Keep the
  // profile scoped to that root without encoding a Windows path as a config key.
  if (securityMode === 'isolated') {
    for (const override of profileOverrides()) args.push('--config', override);
  } else {
    args.push('--sandbox', 'workspace-write');
    if (process.platform === 'win32') args.push('--config', 'windows.sandbox=' + quoteToml(windowsSandboxMode));
  }
  args.push('exec', '--ignore-user-config');
  if (securityMode === 'isolated') args.push('--ignore-rules');
  args.push('--strict-config', '--skip-git-repo-check');
  if (promptMode === 'resume' && threadId) args.push('resume', String(threadId));
  args.push('--json', '-');
  return args;
}

function withoutTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote === '"') { escaped = true; continue; }
    if ((char === '"' || char === "'") && (!quote || quote === char)) { quote = quote ? null : char; continue; }
    if (char === '#' && !quote) return line.slice(0, index);
  }
  return line;
}

function parseSimpleTomlValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('"')) {
    try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : null; }
    catch { return null; }
  }
  if (value.startsWith("'")) return value.endsWith("'") && value.length >= 2 ? value.slice(1, -1) : null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function selectedWindowsSandbox(codexHome) {
  if (process.platform !== 'win32') return null;
  let text;
  try { text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 'unelevated'; throw agentProviderError('CODEX_NATIVE_CONFIG_UNREADABLE', 'Cannot inspect selected native security policy'); }
  return parseWindowsNativeSandboxPolicy(text);
}

// Accept the inspected table form; ambiguous TOML security settings never select a fallback.
export function parseWindowsNativeSandboxPolicy(text) {
  let windows = false, selected = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = withoutTomlComment(raw).trim();
    if (line.startsWith('[')) {
      if (/windows/i.test(line) && line !== '[windows]') throw agentProviderError('CODEX_NATIVE_POLICY_UNVERIFIED', 'Windows security table requires explicit verification');
      windows = line === '[windows]';
      continue;
    }
    const key = line.split('=')[0]?.trim();
    if (/windows/i.test(key || '')) throw agentProviderError('CODEX_NATIVE_POLICY_UNVERIFIED', 'Dotted or inline Windows security policy requires explicit verification');
    if (windows && /sandbox/i.test(key || '')) {
      if (!/^sandbox\s*=/.test(line) || selected !== null) throw agentProviderError('CODEX_NATIVE_POLICY_UNVERIFIED', 'Ambiguous Windows sandbox policy');
      selected = parseSimpleTomlValue(line.slice(line.indexOf('=') + 1));
      if (!['unelevated', 'elevated', 'mxc'].includes(selected)) throw agentProviderError('CODEX_NATIVE_POLICY_UNSUPPORTED', 'Selected Windows sandbox is unknown');
    }
  }
  return selected ?? 'unelevated';
}

function nativeRulesIdentity(codexHome) {
  const hash = crypto.createHash('sha256'); let files = 0, bytes = 0;
  const directory = path.join(codexHome, 'rules');
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw agentProviderError('CODEX_NATIVE_POLICY_UNVERIFIED', 'Native rules contain a symbolic link');
      if (entry.isDirectory()) { if (++files > 128) throw agentProviderError('CODEX_NATIVE_POLICY_UNVERIFIED', 'Native rule tree is too large'); walk(file); }
      else if (entry.isFile() && entry.name.endsWith('.rules')) {
        const stat = fs.statSync(file); bytes += stat.size;
        if (++files > 128 || bytes > 512000) throw agentProviderError('CODEX_NATIVE_POLICY_UNVERIFIED', 'Native rules exceed inspection bounds');
        hash.update(path.relative(directory, file)); hash.update(fs.readFileSync(file));
      }
    }
  }
  if (fs.existsSync(directory)) walk(directory);
  return hash.digest('hex');
}

/**
 * Inherit only the user's selected model and one explicit model provider. MCP,
 * hooks, plugins, sandbox, approval, and arbitrary user TOML never enter a Task.
 */
function readCodexModelConfiguration(codexHome) {
  if (!codexHome) return { model: null, modelProvider: null, provider: {} };
  const file = path.join(codexHome, 'config.toml');
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return { model: null, modelProvider: null, provider: {} };
    text = fs.readFileSync(file, 'utf8');
  } catch { return { model: null, modelProvider: null, provider: {} }; }

  let section = '';
  let model = null;
  let modelProvider = null;
  const providers = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = withoutTomlComment(rawLine).trim();
    if (!line) continue;
    const table = line.match(/^\[\s*model_providers\.(?:"([A-Za-z0-9_-]{1,64})"|'([A-Za-z0-9_-]{1,64})'|([A-Za-z0-9_-]{1,64}))\s*\]$/);
    if (table) {
      section = table[1] ?? table[2] ?? table[3];
      if (!providers.has(section)) providers.set(section, {});
      continue;
    }
    if (line.startsWith('[')) { section = ''; continue; }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const parsed = parseSimpleTomlValue(rawValue);
    if (!section) {
      if (key === 'model' && typeof parsed === 'string' && parsed.length <= 120) model = parsed;
      if (key === 'model_provider' && typeof parsed === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(parsed)) modelProvider = parsed;
      continue;
    }
    if (!INHERITED_PROVIDER_FIELDS.includes(key)) continue;
    if (key === 'name' || key === 'base_url' || key === 'wire_api' || key === 'env_key') {
      if (typeof parsed !== 'string' || parsed.length > 2048) continue;
      if (key === 'base_url') {
        try {
          const url = new URL(parsed);
          const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
          const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
          if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) continue;
          if (url.username || url.password || url.search || url.hash) continue;
        } catch { continue; }
      }
      if (key === 'env_key' && parsed !== 'OPENAI_API_KEY') continue;
      providers.get(section)[key] = parsed;
    } else if (key === 'requires_openai_auth' && typeof parsed === 'boolean') {
      providers.get(section)[key] = parsed;
    }
  }
  const provider = modelProvider ? providers.get(modelProvider) ?? {} : {};
  return {
    model,
    modelProvider,
    provider: Object.fromEntries(Object.entries(provider).filter(([key]) => INHERITED_PROVIDER_FIELDS.includes(key)))
  };
}

function inheritedProviderArgs(configuration) {
  const selected = configuration?.modelProvider;
  if (!selected || !/^[A-Za-z0-9_-]{1,64}$/.test(selected)) return [];
  const args = ['--config', `model_provider=${quoteToml(selected)}`];
  const provider = configuration.provider ?? {};
  for (const key of INHERITED_PROVIDER_FIELDS) {
    const value = provider[key];
    if (typeof value !== 'string' && typeof value !== 'boolean') continue;
    const literal = typeof value === 'boolean' ? String(value) : quoteToml(value);
    args.push('--config', `model_providers.${quoteToml(selected)}.${key}=${literal}`);
  }
  return args;
}

function inspectSelectedCodexCli(cli) {
  const installed = Boolean(cli.executable());
  const version = cli.probe(['--version']);
  if (!version.available) return { installed, available: false, reason: installed ? 'unsupported_cli' : 'not_installed', version: null, probePhase: 'version', probeCode: cli.discoveryCode ?? version.code ?? 'PROBE_FAILED' };
  const top = cli.probe(['--help']);
  const exec = cli.probe(['exec', '--help']);
  const resume = cli.probe(['exec', 'resume', '--help']);
  const topHelp = `${top.stdout}\n${top.stderr}`;
  const execHelp = `${exec.stdout}\n${exec.stderr}`;
  const resumeHelp = `${resume.stdout}\n${resume.stderr}`;
  const topSupported = top.available && /--config/.test(topHelp)
    && /--ask-for-approval/.test(topHelp) && /--cd/.test(topHelp);
  const execSupported = exec.available && /--json/.test(execHelp) && /--ignore-user-config/.test(execHelp)
    && /--ignore-rules/.test(execHelp) && /--strict-config/.test(execHelp)
    && /--skip-git-repo-check/.test(execHelp);
  const supported = topSupported && execSupported;
  const resumeSupported = resume.available && /--json/.test(resumeHelp) && /\[SESSION_ID\]/i.test(resumeHelp);
  return {
    installed,
    available: supported,
    reason: supported ? null : 'unsupported_cli',
    version: version.stdout.trim().slice(0, 100),
    probePhase: supported ? 'ready' : !topSupported ? 'help' : 'exec-help',
    probeCode: supported ? null : !topSupported ? top.code ?? 'CLI_PROTOCOL_UNSUPPORTED' : exec.code ?? 'CLI_PROTOCOL_UNSUPPORTED',
    supportsResume: resumeSupported,
    nativeSandboxSupported: /--sandbox/.test(topHelp) && /workspace-write/.test(topHelp)
  };
}

function inspectCodexCli(cli) {
  if (typeof cli.candidates !== 'function') return inspectSelectedCodexCli(cli);
  const candidates = cli.candidates();
  let first = null;
  for (const executable of candidates.slice(0, 16)) {
    cli.selectExecutable(executable);
    const result = inspectSelectedCodexCli(cli);
    if (result.available) return result;
    first ??= { executable, result };
  }
  if (first) { cli.selectExecutable(first.executable); return first.result; }
  return { installed: false, available: false, reason: cli.discoveryCode ? 'invalid_cli_path' : 'not_installed', version: null,
    probePhase: 'discovery', probeCode: cli.discoveryCode ?? 'CLI_NOT_FOUND' };
}

function loginState(cli) {
  const result = cli.probe(['login', 'status'], { timeoutMs: 5000 });
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (!result.available) return false;
  return /logged in|authenticated/.test(text) && !/not logged in|not authenticated/.test(text);
}

function extractText(event) {
  const item = event?.item ?? event?.response_item ?? event?.data?.item;
  if (item?.type !== 'agent_message' || typeof item.text !== 'string') return '';
  return item.text;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens);
  const value = {};
  if (Number.isFinite(inputTokens) && inputTokens > 0) value.inputTokens = inputTokens;
  if (Number.isFinite(outputTokens) && outputTokens > 0) value.outputTokens = outputTokens;
  return Object.keys(value).length ? value : null;
}

function makeEvent(type, turn, data = {}) {
  return { type, data: { turn, ...data } };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCodexAgentProvider({ executable, cliProcess = null, resolveTaskWorkspace = null,
  listWorkspaceRoots = () => [], excludedRoots = [], stagingRoot = null, createStage = createStagingWorkspace,
  applyChanges = async () => { throw agentProviderError('AGENT_BOUNDARY_UNSUPPORTED', 'Capability Broker import adapter is unavailable'); },
  environment = process.env, codexHome = null, securityMode = 'native', authorizeOpenAiEnvironment = () => false,
  approvalStatus = () => null, cancelApproval = () => ({ cancelled: false }), timeoutMs = 10 * 60 * 1000, log = () => {} } = {}) {
  const resolvedCodexHome = codexHome || environment.CODEX_HOME || path.join(environment.USERPROFILE || os.homedir(), '.codex');
  const cli = cliProcess ?? new CliAgentProcess({ name: 'codex', executable,
    envSource: () => ({ ...environment, CODEX_HOME: resolvedCodexHome }) });
  let inspection = inspectCodexCli(cli);
  let authenticated = inspection.available ? loginState(cli) : false;
  let lastProbeAt = Date.now();
  let sandboxCapable = null;
  let lastSecurityIdentity = null;
  let inspectionGeneration = 0;
  let inspectedIdentity = JSON.stringify([cli.executable(), inspection.version]);
  const sessions = new Map();
  const providerConfig = { model: null, reasoningEffort: null };

  function refreshInspection(force = false) {
    if (!force && Date.now() - lastProbeAt < HEALTH_TTL_MS) return;
    inspection = inspectCodexCli(cli);
    const identity = JSON.stringify([cli.executable(), inspection.version]);
    if (identity !== inspectedIdentity) { sandboxCapable = null; inspectionGeneration++; }
    inspectedIdentity = identity;
    authenticated = inspection.available ? loginState(cli) : false;
    lastProbeAt = Date.now();
  }

  function executionSecurity() {
    let executableStat = null;
    try { const stat = fs.statSync(cli.executable()); executableStat = [stat.size, stat.mtimeMs]; }
    catch { executableStat = 'unavailable'; /* Fixtures and failed file probes retain a distinct policy identity. */ }
    const selectedSandbox = selectedWindowsSandbox(resolvedCodexHome);
    const identity = crypto.createHash('sha256').update(JSON.stringify([inspectedIdentity, executableStat, securityMode, selectedSandbox, nativeRulesIdentity(resolvedCodexHome)])).digest('hex');
    if (lastSecurityIdentity !== null && lastSecurityIdentity !== identity) { sandboxCapable = null; inspectionGeneration++; }
    lastSecurityIdentity = identity;
    return { mode: securityMode, nativeSandboxSupported: inspection.nativeSandboxSupported === true
        && (process.platform !== 'win32' || selectedSandbox === 'unelevated'),
      nativeSandboxMode: process.platform === 'win32' ? 'windows-' + selectedSandbox + '/workspace-write' : 'workspace-write',
      nativeApprovalSupported: true, nativeApprovalPolicy: 'never (deny escalation; noninteractive)',
      executionBoundary: 'agent-native', workspaceAccess: 'staging cwd; native OS policy', directFilesystemAccess: true,
      platformToolPermissions: 'capability-broker', strictIsolationVerified: false, requiresConfirmation: true,
      identity,
      securityLimitations: ['Native Security may read host files outside Staging. Native OS access is not mediated by CetaMesh tools.',
        'Native writes outside the declared workspace are governed by Codex; temporary writable paths follow its policy.',
        'Windows unelevated network isolation is environment-based, not a dedicated firewall boundary.',
        'Do not access CetaMesh credentials or private IPC. Staging is not an OS sandbox.'] };
  }

  function requireSession(sessionId) {
    const session = sessions.get(String(sessionId ?? ''));
    if (!session || session.closed) throw agentProviderError('SESSION_NOT_FOUND', 'Codex Task session is not available');
    return session;
  }

  function emit(session, event) {
    const seq = ++session.nextSequence;
    session.events.push({ ...event, seq, eventId: `${session.id}:${seq}` });
    if (session.events.length > CAPTURE_MAX) session.events.splice(0, session.events.length - CAPTURE_MAX);
    const waiters = session.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  function emitTurnEnd(session, turn, kind, error = null, usage = null) {
    if (session.activeRun?.turnId !== turn) return;
    const structuredError = error === null ? null : typeof error === 'string'
      ? { code: kind === 'error' ? session.lastError?.code ?? 'PROVIDER_ERROR' : 'PROVIDER_ERROR', message: error }
      : { code: String(error.code || 'PROVIDER_ERROR'), message: String(error.message || 'Codex execution failed') };
    emit(session, makeEvent('turn/end', turn, {
      reason: { kind, ...(structuredError ? { error: structuredError } : {}), ...(usage ? { usage } : {}) }
    }));
    session.activeRun = null;
  }

  function classifyProcessFailure(result, run) {
    if (run.failed) return { code: 'CODEX_TURN_FAILED', message: 'Codex execution failed' };
    const stderr = String(result.stderr ?? '').toLowerCase();
    if (stderr.includes('windows unelevated restricted-token sandbox cannot enforce split filesystem read restrictions')
      && stderr.includes('refusing to run unsandboxed')) {
      return {
        code: 'CODEX_SANDBOX_UNAVAILABLE',
        message: 'Codex selected native sandbox is unavailable; no unsafe fallback was attempted'
      };
    }
    return { code: 'PROVIDER_ERROR', message: 'Codex execution failed' };
  }

  async function finalizeRun(session, run, result) {
    if (session.closed || session.activeRun !== run) return;
    flushOutput(session, run);
    if (result.timedOut) {
      session.lastRunStatus = 'timeout';
      session.lastError = { code: 'AGENT_TIMEOUT' };
      emitTurnEnd(session, run.turnId, 'error', { code: 'AGENT_TIMEOUT', message: 'Codex execution timed out' });
      return;
    }
    if (result.cancelled) {
      session.lastRunStatus = 'cancelled';
      emitTurnEnd(session, run.turnId, 'aborted');
      return;
    }
    if (result.exitCode !== 0 || run.failed || !run.turnCompleted) {
      const failure = classifyProcessFailure(result, run);
      if (failure.code === 'CODEX_SANDBOX_UNAVAILABLE' && run.inspectionGeneration === inspectionGeneration) sandboxCapable = false;
      session.lastRunStatus = 'failed';
      session.lastError = { code: failure.code, exitCode: result.exitCode };
      emitTurnEnd(session, run.turnId, 'error', failure);
      return;
    }
    if (run.inspectionGeneration === inspectionGeneration) sandboxCapable = true;
    let changeSet;
    try {
      changeSet = collectStagedChanges(session.stage);
    } catch (error) {
      session.lastRunStatus = 'reconciliation-required';
      session.lastError = { code: error?.code ?? 'WORKSPACE_RECONCILIATION_REQUIRED' };
      emitTurnEnd(session, run.turnId, 'error', { code: session.lastError.code, message: session.lastError.code === 'WORKSPACE_RECONCILIATION_REQUIRED'
        ? '工作区与任务快照存在冲突，修改尚未导入；请核验后恢复任务。'
        : `无法校验工作区快照（${session.lastError.code}），修改尚未导入；请检查可读性或快照限制后恢复任务。` });
      return;
    }
    let usage = run.usage ?? null;
    if (changeSet.changes.length) {
      let imported;
      try {
        imported = await applyChanges({
          taskId: session.taskId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          provider: 'codex',
          requestId: `codex-import-${crypto.randomUUID()}`,
          changes: changeSet.changes,
          summary: changeSet.summary
        });
      } catch (error) {
        session.lastRunStatus = 'import-failed';
        session.lastError = { code: error?.code ?? 'WORKSPACE_IMPORT_FAILED' };
        emitTurnEnd(session, run.turnId, 'error', { code: session.lastError.code, message: 'Capability Broker could not import the Codex result' });
        return;
      }
      if (imported?.status === 'pending') {
        session.waitingForApproval = imported.approvalId;
        session.lastRunStatus = 'waiting-for-approval';
        const outcome = await waitForImportApproval(session, imported.approvalId);
        session.waitingForApproval = null;
        if (outcome.status !== 'completed') {
          session.lastRunStatus = outcome.status;
          session.lastError = outcome.code ? { code: outcome.code } : null;
          if (outcome.status === 'cancelled') emitTurnEnd(session, run.turnId, 'aborted');
          else emitTurnEnd(session, run.turnId, 'error', { code: outcome.code ?? 'WORKSPACE_IMPORT_NOT_COMPLETED', message: outcome.status === 'rejected'
            ? 'Owner rejected the Workspace import' : 'Workspace import did not complete' });
          return;
        }
      } else if (imported?.status !== 'completed') {
        session.lastRunStatus = 'import-denied';
        emitTurnEnd(session, run.turnId, 'error', { code: 'WORKSPACE_IMPORT_NOT_COMPLETED', message: 'Capability Broker did not complete the Workspace import' });
        return;
      }
      try { refreshStagingBaseline(session.stage); }
      catch (error) {
        session.lastRunStatus = 'reconciliation-required';
        session.lastError = { code: error?.code ?? 'WORKSPACE_RECONCILIATION_REQUIRED' };
        emitTurnEnd(session, run.turnId, 'error', { code: session.lastError.code, message: 'Workspace reconciliation failed after import' });
        return;
      }
    }
    session.lastUsage = usage;
    session.lastRunStatus = 'completed';
    if (run.text) {
      emit(session, makeEvent('assistant/message', run.turnId, {
        message: { content: [{ type: 'text', text: run.text }], ...(usage ? { usage } : {}) }
      }));
    }
    emitTurnEnd(session, run.turnId, 'completed', null, usage);
  }

  async function waitForImportApproval(session, approvalId) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!session.closed && !session.cancelledApprovals.has(approvalId) && Date.now() < deadline) {
      const status = approvalStatus(approvalId);
      if (status?.status && status.status !== 'pending') return status;
      await new Promise(resolve => {
        const timer = setTimeout(() => { session.approvalWaitWake = null; resolve(); }, 250);
        session.approvalWaitWake = () => { clearTimeout(timer); session.approvalWaitWake = null; resolve(); };
      });
    }
    const cancelled = session.closed || session.cancelledApprovals.has(approvalId);
    return { status: cancelled ? 'cancelled' : 'expired', code: cancelled ? 'INVOKE_CANCELLED' : 'APPROVAL_EXPIRED' };
  }

  function parseOutput(session, run, text) {
    run.pendingText += text;
    const lines = run.pendingText.split(/\r?\n/);
    run.pendingText = lines.pop() ?? '';
    for (const line of lines) parseLine(session, run, line);
  }

  function flushOutput(session, run) {
    const remaining = run.pendingText;
    run.pendingText = '';
    parseLine(session, run, remaining);
  }

  function parseLine(session, run, line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { /* Ignore non-JSON CLI diagnostics between protocol records. */ return; }
      if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item?.type === 'command_execution') {
        const item = event.item;
        emit(session, makeEvent('tool/activity', run.turnId, { activity: {
          id: String(item.id ?? run.turnId).slice(0, 160), capability: 'codex.native.command',
          name: 'Codex 原生命令（由原生策略控制）', executionBoundary: 'agent-native',
          status: event.type === 'item.completed' ? (item.exit_code === 0 ? 'completed' : 'failed') : 'running',
          exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null
        } }));
      }
      if (event.type === 'thread.started') {
        if (typeof event.thread_id === 'string') session.threadId = event.thread_id;
      } else if (event.type === 'item.completed') {
        const value = extractText(event);
        if (value) {
          run.text = value.slice(0, 200_000);
          emit(session, makeEvent('assistant/chunk', run.turnId, {
            chunk: { type: 'text-delta', text: value.slice(0, 32_000) }
          }));
        }
      } else if (event.type === 'turn.completed') {
        run.turnCompleted = true;
        run.usage = normalizeUsage(event.usage ?? event.data?.usage);
      } else if (event.type === 'turn.failed') {
        run.failed = true;
      }
  }

  const contract = defineAgentProvider({
    id: 'codex',
    label: 'Codex',
    eventProtocol: AGENT_EVENT_PROTOCOL_TURN_V1,
    capabilityExtras: {
      workspaceBoundary: 'native-staged',
      supportsFreshSession: true,
      supportsResume: inspection.supportsResume === true,
      contextUsage: { available: true, source: 'Codex exec JSONL usage events when emitted' },
      executionMode: 'native-security-staging', requiresSessionCleanup: true
    },
    methods: {
      async createSession({ taskId, workspaceId, modelProvider, model, reasoningEffort } = {}) {
        refreshInspection();
        if (securityMode !== 'native') throw agentProviderError('ISOLATED_ENVIRONMENT_UNVERIFIED', 'Isolated Workspace has no verified execution environment');
        if (process.platform === 'win32' && selectedWindowsSandbox(resolvedCodexHome) !== 'unelevated') throw agentProviderError('CODEX_NATIVE_POLICY_UNVERIFIED', 'Selected Windows backend requires independent verification; no fallback is allowed');
        if (!inspection.nativeSandboxSupported) throw agentProviderError('CODEX_NATIVE_POLICY_UNSUPPORTED', 'Installed Codex does not advertise workspace-write sandbox support');
        if (!inspection.available) throw agentProviderError('PROVIDER_UNAVAILABLE', 'Codex CLI is not installed or lacks the inspected exec interface');
        if (!authenticated) throw agentProviderError('PROVIDER_UNAVAILABLE', 'Codex needs authentication in its own secure configuration');
        if (!taskId || !workspaceId) throw agentProviderError('TASK_REQUIRED', 'Codex requires a Task and its bound Workspace');
        const inheritedModelConfiguration = readCodexModelConfiguration(resolvedCodexHome);
        if (modelProvider && modelProvider !== inheritedModelConfiguration.modelProvider) {
          throw agentProviderError('MODEL_PROVIDER_UNSUPPORTED', 'Codex CLI configuration does not match the Task authorized model provider');
        }
        if (typeof resolveTaskWorkspace !== 'function') throw agentProviderError('AGENT_BOUNDARY_UNSUPPORTED', 'Task Workspace resolver is unavailable');
        const binding = await resolveTaskWorkspace({ taskId: String(taskId), workspaceId: String(workspaceId) });
        if (!binding?.task || binding.task.id !== String(taskId) || binding.task.workspaceId !== String(workspaceId)
          || binding.workspace?.id !== String(workspaceId) || typeof binding.workspace.root !== 'string') {
          throw agentProviderError('TASK_WORKSPACE_MISMATCH', 'Codex Task and Workspace binding is invalid');
        }
        const registeredRoots = await listWorkspaceRoots();
        const stage = await createStage({
          taskId: binding.task.id,
          workspaceId: binding.workspace.id,
          sourceRoot: binding.workspace.root,
          stagingRoot: stagingRoot ?? path.join(os.tmpdir(), 'CetaMesh', 'agent-staging'),
          additionalWorkspaceRoots: (Array.isArray(registeredRoots) ? registeredRoots : []).map((row) => typeof row === 'string' ? row : row.root),
          excludedRoots
        });
        const id = crypto.randomUUID();
        sessions.set(id, {
          id,
          taskId: binding.task.id,
          workspaceId: binding.workspace.id,
          task: binding.task,
          model: typeof model === 'string' && model.trim() ? model.trim() : providerConfig.model ?? inheritedModelConfiguration.model,
          reasoningEffort: typeof reasoningEffort === 'string' && reasoningEffort.trim()
            ? reasoningEffort.trim() : providerConfig.reasoningEffort,
          modelConfiguration: inheritedModelConfiguration,
          stage,
          threadId: null,
          activeRun: null,
          waitingForApproval: null,
          cancelledApprovals: new Set(),
          approvalWaitWake: null,
          lastRunStatus: 'idle',
          lastError: null,
          lastUsage: null,
          events: [],
          nextSequence: 0,
          waiters: [],
          closed: false
        });
        return { sessionId: id, provider: 'codex', taskId: binding.task.id, workspaceId: binding.workspace.id, cwd: stage.root };
      },

      async send({ sessionId, content } = {}) {
        const session = requireSession(sessionId);
        if (session.activeRun) throw agentProviderError('TURN_BUSY', 'Codex Task session already has an active turn');
        const turnId = crypto.randomUUID();
        const prompt = [
          `[CetaMesh Task ${session.taskId}]`,
          `Workspace: ${session.workspaceId}`,
          `Task goal: ${session.task.goal}`,
          session.task.checkpoint?.summary ? `Checkpoint: ${session.task.checkpoint.summary}` : '',
          session.task.checkpoint?.nextAction ? `Next action: ${session.task.checkpoint.nextAction}` : '',
          'Use this staging copy for Task work. It is not host-file read isolation. Native OS operations follow Codex security policy; CetaMesh only approves imports and platform tools. Never access CetaMesh credentials, private IPC, or unrelated host files.',
          String(content ?? '')
        ].filter(Boolean).join('\n\n');
        const run = { turnId, inspectionGeneration, pendingText: '', text: '', usage: null, turnCompleted: false, failed: false, handle: null };
        session.activeRun = run;
        session.lastRunStatus = 'running';
        emit(session, makeEvent('turn/start', turnId));
        const args = buildCodexExecArgs({
          stageRoot: session.stage.root,
          promptMode: session.threadId && inspection.supportsResume ? 'resume' : 'fresh',
          threadId: session.threadId,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          modelConfiguration: session.modelConfiguration, securityMode, windowsSandboxMode: selectedWindowsSandbox(resolvedCodexHome)
        });
        try {
          const authorized = authorizeOpenAiEnvironment() === true;
          const env = { CODEX_HOME: resolvedCodexHome };
          const authorizedEnvKeys = [];
          if (authorized) {
            for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
              if (environment[key] !== undefined) { env[key] = environment[key]; authorizedEnvKeys.push(key); }
            }
          }
          run.handle = cli.startSession({
            sessionId: `${session.id}:${turnId}`,
            cwd: session.stage.root,
            args,
            input: prompt,
            timeoutMs,
            env,
            authorizedEnvKeys,
            onStdout: (chunk) => parseOutput(session, run, chunk)
          });
        } catch (error) {
          session.activeRun = null;
          throw agentProviderError(error?.code === 'PROVIDER_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'PROCESS_START_FAILED', 'Unable to start the Codex CLI process', { cause: error });
        }
        run.finalized = run.handle.done.then((result) => finalizeRun(session, run, result)).catch((error) => {
          if (session.activeRun === run) {
            session.lastRunStatus = 'failed';
            session.lastError = { code: error?.code ?? 'PROVIDER_ERROR' };
            emitTurnEnd(session, turnId, 'error', { code: session.lastError.code, message: 'Codex process failed' });
          }
        });
        return { accepted: true, provider: 'codex', sessionId, taskId: session.taskId, workspaceId: session.workspaceId, turnId };
      },

      async cancel({ sessionId } = {}) {
        const session = requireSession(sessionId);
        if (session.waitingForApproval) {
          const approvalId = session.waitingForApproval;
          const run = session.activeRun;
          session.cancelledApprovals.add(approvalId);
          try { await cancelApproval(approvalId); }
          catch (error) { log(`Codex approval cancellation failed: ${error?.code ?? 'APPROVAL_CANCEL_FAILED'}`); }
          session.approvalWaitWake?.();
          if (run?.finalized) await run.finalized;
          let cleanupError = null;
          try { cleanupStagingWorkspace(session.stage); }
          catch (error) { cleanupError = error; }
          session.closed = true;
          session.lastRunStatus = 'cancelled';
          sessions.delete(session.id);
          for (const wake of session.waiters.splice(0)) wake();
          if (cleanupError) throw agentProviderError('STAGING_CLEANUP_FAILED', 'Cancelled Codex staging data could not be cleaned up', { cause: cleanupError });
          return { cancelled: true, sessionId, approvalId, state: 'cancelled' };
        }
        if (!session.activeRun?.handle) return { cancelled: false, reason: 'not-running', sessionId };
        return session.activeRun.handle.cancel();
      },

      async status({ sessionId } = {}) {
        const session = requireSession(sessionId);
        return {
          provider: 'codex', sessionId, taskId: session.taskId, workspaceId: session.workspaceId,
          running: Boolean(session.activeRun), waitingForApproval: Boolean(session.waitingForApproval),
          approvalId: session.waitingForApproval, lastRunStatus: session.lastRunStatus,
          errorCode: session.lastError?.code ?? null
        };
      },

      async contextUsage({ sessionId } = {}) {
        const session = requireSession(sessionId);
        return session.lastUsage
          ? { sessionId, provider: 'codex', available: true, usage: session.lastUsage }
          : { sessionId, provider: 'codex', available: false };
      },

      async resume({ sessionId } = {}) {
        const session = requireSession(sessionId);
        if (!inspection.supportsResume || !session.threadId) return { resumed: false, provider: 'codex', freshSessionRequired: true };
        return { resumed: true, provider: 'codex', sessionId, threadId: session.threadId };
      },

      async closeSession({ sessionId } = {}) {
        const session = requireSession(sessionId);
        session.closed = true;
        if (session.waitingForApproval) {
          session.cancelledApprovals.add(session.waitingForApproval);
          try { await cancelApproval(session.waitingForApproval); }
          catch (error) { log(`Codex approval cancellation failed: ${error?.code ?? 'APPROVAL_CANCEL_FAILED'}`); }
          session.approvalWaitWake?.();
        }
        if (session.activeRun?.handle) {
          session.activeRun.handle.cancel();
          await session.activeRun.handle.done.catch(() => {});
        }
        if (session.activeRun?.finalized) await session.activeRun.finalized;
        cleanupStagingWorkspace(session.stage);
        for (const wake of session.waiters.splice(0)) wake();
        sessions.delete(session.id);
        return { closed: true, provider: 'codex', sessionId };
      },

      async selectModel({ sessionId, model, reasoningEffort } = {}) {
        const session = requireSession(sessionId);
        if (model !== undefined) session.model = String(model || '') || null;
        if (reasoningEffort !== undefined) session.reasoningEffort = String(reasoningEffort || '') || null;
        return { sessionId, provider: 'codex', selected: { model: session.model, reasoningEffort: session.reasoningEffort } };
      },

      async health({ refresh = false } = {}) {
        refreshInspection(refresh === true);
        const security = executionSecurity();
        const available = inspection.available && authenticated;
        return {
          available,
          installed: inspection.installed,
          compatible: inspection.available,
          taskEligible: available && security.nativeSandboxSupported === true && securityMode === 'native' && sandboxCapable !== false && typeof resolveTaskWorkspace === 'function',
          provider: 'codex',
          version: inspection.version,
          authenticated,
          status: security.nativeSandboxSupported !== true ? 'sandbox_unavailable' : sandboxCapable === false ? 'sandbox_unavailable' : authenticated ? 'ready' : inspection.available ? 'needs_auth' : 'unavailable',
          reason: inspection.reason ?? (security.nativeSandboxSupported !== true ? 'native_policy_unverified' : !authenticated ? 'needs_auth' : sandboxCapable === false ? 'sandbox_unavailable' : null),
          configured: inspection.available,
          reachable: null,
          sessionCapable: available,
          sandboxCapable,
          security,
          readyForTask: available && security.nativeSandboxSupported === true && sandboxCapable === true && securityMode === 'native',
          installKind: cli.installKind?.() ?? 'unknown',
          probePhase: inspection.available && !authenticated ? 'authentication' : inspection.probePhase,
          probeCode: inspection.available && !authenticated ? 'CODEX_AUTH_REQUIRED' : inspection.probeCode,
          detectedVersion: inspection.version,
          checkedAt: new Date(lastProbeAt).toISOString(),
          requiresStandaloneNode: /\.(cmd|bat)$/i.test(cli.executable() ?? ''),
          reprobedAt: lastProbeAt
        };
      },

      async *follow({ sessionId, signal, sinceSequence = 0 } = {}) {
        const session = requireSession(sessionId);
        if (!Number.isSafeInteger(sinceSequence) || sinceSequence < 0) {
          throw agentProviderError('INVALID_PARAMS', 'Codex Follow cursor must be a non-negative safe integer');
        }
        if (sinceSequence > session.nextSequence) {
          throw agentProviderError('AGENT_EVENT_GAP', 'Codex Follow cursor is ahead of this Session event stream');
        }
        let sequence = sinceSequence;
        while (!session.closed && !signal?.aborted) {
          if (session.events.length && sequence < session.events[0].seq - 1) {
            throw agentProviderError('AGENT_EVENT_GAP', 'Codex Follow cursor is older than the retained event window');
          }
          const next = session.events.find(event => event.seq > sequence);
          if (next) {
            sequence = next.seq;
            yield next;
            continue;
          }
          await new Promise((resolve) => {
            const done = () => {
              signal?.removeEventListener('abort', done);
              session.waiters = session.waiters.filter((wake) => wake !== done);
              resolve();
            };
            session.waiters.push(done);
            signal?.addEventListener('abort', done, { once: true });
            if (signal?.aborted) done();
          });
        }
      }
    }
  });
  return Object.freeze({
    ...contract,
    // Compatibility projection reads the same current inspection as health; never a startup snapshot.
    capabilities() {
      return Object.freeze({ ...contract.capabilities(), security: executionSecurity(), installed: inspection.installed, compatible: inspection.available,
        available: inspection.available && authenticated, version: inspection.version,
        reason: inspection.reason ?? (authenticated ? null : 'needs_auth'),
        health: authenticated ? 'ready' : inspection.available ? 'needs_auth' : 'unavailable', supportsResume: inspection.supportsResume === true });
    },
    configure(settings = {}) {
      const allowed = new Set(['model', 'reasoningEffort']);
      for (const key of Object.keys(settings ?? {})) {
        if (!allowed.has(key)) throw agentProviderError('INVALID_PARAMS', `Unsupported Codex setting: ${key}`);
      }
      if (settings.model !== undefined) providerConfig.model = String(settings.model || '') || null;
      if (settings.reasoningEffort !== undefined) providerConfig.reasoningEffort = String(settings.reasoningEffort || '') || null;
      return { provider: 'codex', configured: { ...providerConfig } };
    },
    async shutdown() {
      await cli.shutdown();
      for (const session of sessions.values()) {
        try { cleanupStagingWorkspace(session.stage); }
        catch (error) { log(`Codex staging cleanup failed: ${error?.code ?? 'STAGING_CLEANUP_FAILED'}`); }
        session.closed = true;
        for (const wake of session.waiters.splice(0)) wake();
      }
      sessions.clear();
      log('Codex Agent Provider 已关闭');
    },
    _inspection: { ...inspection, authenticated },
    _sessions: sessions
  });
}
