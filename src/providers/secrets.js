// CetaMesh Desktop —— per-provider API key storage.
//
// Keys live in <dataRoot>/state/provider-keys.json with mode 0600 and atomic replacement. Reads
// exposed to the UI are always masked (hint + updatedAt); the raw key never leaves this module
// except for an explicit outbound test against the provider's own models endpoint.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE_VERSION = 1;
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_KEY_CHARS = 512;

const DEFAULT_BASE_URLS = Object.freeze({
  'deepseek-official': 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1'
});

export class ProviderSecretError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderSecretError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderSecretError(code, message);
}

function maskKey(key) {
  const text = String(key ?? '');
  if (text.length <= 4) return '••••';
  return `••••${text.slice(-4)}`;
}

function normalizeProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (!PROVIDER_RE.test(provider)) {
    fail('PROVIDER_SECRET_INVALID', 'provider 只能包含小写字母、数字、点、下划线和连字符');
  }
  return provider;
}

function normalizeApiKey(value) {
  const key = String(value ?? '').trim();
  if (key.length < 8 || key.length > MAX_KEY_CHARS || /[\u0000-\u001f]/.test(key)) {
    fail('PROVIDER_SECRET_INVALID', `apiKey 长度必须在 8~${MAX_KEY_CHARS} 且不能包含控制字符`);
  }
  return key;
}

function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('PROVIDER_SECRET_INVALID', 'baseUrl 必须是合法 URL');
  }
  if (url.username || url.password) fail('PROVIDER_SECRET_INVALID', 'baseUrl 不能包含用户信息');
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail('PROVIDER_SECRET_INVALID', '远程 baseUrl 必须是 https；仅允许 localhost、127.0.0.1 或 ::1 使用 http');
  }
  return text.replace(/\/+$/, '');
}

function publicEntry(provider, entry) {
  return {
    provider,
    configured: true,
    hint: maskKey(entry.apiKey),
    baseUrl: entry.baseUrl ?? '',
    updatedAt: entry.updatedAt ?? null,
    revision: typeof entry.revision==='string'?entry.revision:null
  };
}

/**
 * Create the credential store. `fileOps` exists for deterministic tests; production uses node:fs.
 */
export function createProviderSecrets({ root, fileOps = fs } = {}) {
  const baseRoot = path.resolve(root || process.cwd());
  const file = path.join(baseRoot, 'state', 'provider-keys.json');

  function readDocument() {
    let text;
    try {
      text = fileOps.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: FILE_VERSION, providers: {} };
      fail('PROVIDER_SECRET_INVALID', 'provider 凭据文件不可读');
    }
    if (typeof text !== 'string') fail('PROVIDER_SECRET_INVALID', 'provider 凭据文件不可读');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('PROVIDER_SECRET_INVALID', 'provider 凭据文件不是合法 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('PROVIDER_SECRET_INVALID', 'provider 凭据文件根必须是对象');
    }
    const providers = parsed.providers;
    if (providers !== undefined && (!providers || typeof providers !== 'object' || Array.isArray(providers))) {
      fail('PROVIDER_SECRET_INVALID', 'provider 凭据 providers 字段必须是对象');
    }
    return { version: FILE_VERSION, providers: { ...(providers ?? {}) } };
  }

  function writeDocument(document) {
    const directory = path.dirname(file);
    fileOps.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fileOps.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fileOps.renameSync(temporary, file);
    } catch {
      try { fileOps.unlinkSync(temporary); } catch {}
      fail('PROVIDER_SECRET_INVALID', 'provider 凭据写入失败');
    }
  }

  function list() {
    const document = readDocument();
    return Object.entries(document.providers)
      .filter(([, entry]) => entry && typeof entry === 'object' && typeof entry.apiKey === 'string')
      .map(([provider, entry]) => publicEntry(provider, entry))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  function set({ provider, apiKey, baseUrl } = {}) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedKey = normalizeApiKey(apiKey);
    const document = readDocument();
    const previous = document.providers[normalizedProvider];
    const normalizedBaseUrl = baseUrl === undefined
      ? (typeof previous?.baseUrl === 'string' ? previous.baseUrl : '')
      : normalizeBaseUrl(baseUrl);
    document.providers[normalizedProvider] = {
      apiKey: normalizedKey,
      revision: crypto.randomUUID(),
      ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
      // Credential-bound approvals need a distinct revision even under a frozen
      // or rolled-back clock. Preserve the existing ISO metadata/storage format.
      updatedAt: new Date(Math.max(Date.now(),(Date.parse(previous?.updatedAt)||0)+1)).toISOString()
    };
    writeDocument(document);
    return publicEntry(normalizedProvider, document.providers[normalizedProvider]);
  }

  function remove({ provider } = {}) {
    const normalizedProvider = normalizeProvider(provider);
    const document = readDocument();
    const existed = Object.hasOwn(document.providers, normalizedProvider);
    if (existed) {
      delete document.providers[normalizedProvider];
      writeDocument(document);
    }
    return { provider: normalizedProvider, removed: existed };
  }

  function raw(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const document = readDocument();
    const entry = document.providers[normalizedProvider];
    if (!entry || typeof entry.apiKey !== 'string') {
      fail('PROVIDER_SECRET_NOT_FOUND', `provider ${normalizedProvider} 尚未配置 API Key`);
    }
    return { provider: normalizedProvider, apiKey: entry.apiKey, baseUrl: entry.baseUrl ?? '' };
  }

  async function test({ provider, apiKey, baseUrl: candidateBaseUrl, model, fetchImpl = fetch } = {}) {
    const normalizedProvider = normalizeProvider(provider);
    let saved = null;
    try { saved = raw(normalizedProvider); } catch (error) {
      if (error?.code !== 'PROVIDER_SECRET_NOT_FOUND') throw error;
    }
    const key = apiKey === undefined || apiKey === null || apiKey === ''
      ? saved?.apiKey
      : normalizeApiKey(apiKey);
    if (!key) fail('PROVIDER_SECRET_NOT_FOUND', `provider ${normalizedProvider} 尚未配置 API Key`);
    const candidate = typeof candidateBaseUrl === 'string' && candidateBaseUrl.trim()
      ? normalizeBaseUrl(candidateBaseUrl)
      : '';
    const baseUrl = candidate || saved?.baseUrl || DEFAULT_BASE_URLS[normalizedProvider] || '';
    if (!baseUrl) {
      fail('PROVIDER_SECRET_INVALID', `provider ${normalizedProvider} 没有可用的测试地址（请填写 baseUrl）`);
    }
    let catalogResponse;
    try {
      catalogResponse = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      catalogResponse = null;
    }
    const catalogOk = catalogResponse?.ok === true;
    const status = Number(catalogResponse?.status ?? 0);
    if (!catalogOk && (status === 401 || status === 403)) {
      return { provider: normalizedProvider, ok: false, status, phase: 'authentication', configured: true, authenticated: false, reachable: true, inferencing: null, message: '认证失败（API Key 无效或无权限）' };
    }
    if (typeof model === 'string' && model.trim()) {
      let inferenceResponse;
      try {
        inferenceResponse = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ model: model.trim(), messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1, stream: false }),
          signal: AbortSignal.timeout(10000)
        });
      } catch {
        return { provider: normalizedProvider, ok: false, status: 0, phase: 'inference', configured: true, reachable: catalogOk, authenticated: catalogOk, inferencing: false, message: '模型推理请求失败或超时' };
      }
      if (inferenceResponse.ok) {
        return { provider: normalizedProvider, ok: true, status: inferenceResponse.status, phase: 'inference', configured: true, reachable: true, authenticated: true, inferencing: true, catalogAvailable: catalogOk, message: '模型推理成功' };
      }
      return { provider: normalizedProvider, ok: false, status: inferenceResponse.status, phase: 'inference', configured: true, reachable: true, authenticated: inferenceResponse.status !== 401 && inferenceResponse.status !== 403, inferencing: false, catalogAvailable: catalogOk, message: inferenceResponse.status === 401 || inferenceResponse.status === 403 ? '认证失败（API Key 无效或无权限）' : `模型推理返回 HTTP ${inferenceResponse.status}` };
    }
    if (catalogOk) {
      return { provider: normalizedProvider, ok: true, status: catalogResponse.status, phase: 'catalog', configured: true, reachable: true, authenticated: true, inferencing: null, message: '凭据已通过模型目录验证' };
    }
    return { provider: normalizedProvider, ok: false, status, phase: 'catalog', configured: true, reachable: status > 0, authenticated: null, inferencing: null, message: status ? `provider 返回 HTTP ${status}` : '网络请求失败或超时' };
  }

  function execute({ method, params } = {}) {
    switch (method) {
      case 'providers.secrets.list':
        return { secrets: list() };
      case 'providers.secrets.set':
        return { secret: set(params ?? {}) };
      case 'providers.secrets.delete':
        return remove(params ?? {});
      case 'providers.secrets.test':
        return test(params ?? {});
      default:
        return Promise.reject(Object.assign(new Error(`未知 Provider 凭据方法：${String(method)}`), { code: 'METHOD_NOT_FOUND' }));
    }
  }

  return Object.freeze({ execute, list, set, remove, raw, test, filePath: file, maskKey });
}
