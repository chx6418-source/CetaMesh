// Official protocol evidence: https://open.workbuddy.cn/docs/openapi (2026-10-22).
// Credentials are resolved inside the HTTP boundary; no token-bearing response escapes it.
const ORIGIN = 'https://www.workbuddy.cn';
const fail = code => Object.assign(new Error(`WorkBuddy: ${code}`), { code });
const text = value => typeof value === 'string' && value.trim() && value.length <= 65536;
export function createWorkBuddyApiClient({ fetch: fetchImpl = globalThis.fetch, resolveCredential, baseUrl = ORIGIN, allowedAcpOrigins = [], timeoutMs = 30000 } = {}) {
  if (baseUrl !== ORIGIN) throw new Error('WorkBuddy origin must be fixed HTTPS origin');
  // Caller configuration cannot extend the official destination set.
  if (allowedAcpOrigins.some(origin => origin !== 'https://acp.workbuddy.cn')) throw fail('destination_rejected');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail('invalid_timeout');
  async function request(path, scope, body) {
    if (typeof resolveCredential !== 'function') throw fail('developer_configuration_missing');
    const controller = new AbortController();
    const checkAbort = () => { if (controller.signal.aborted) throw fail('request_timeout'); };
    const wait = milliseconds => new Promise((resolve, reject) => {
      checkAbort();
      const onAbort = () => { clearTimeout(delay); reject(fail('request_timeout')); };
      const delay = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail('request_timeout')); }, timeoutMs); });
      return await Promise.race([timeout, (async () => {
        let credential;
        try { credential = await resolveCredential({ signal: controller.signal }); } catch { throw fail(controller.signal.aborted ? 'request_timeout' : 'credential_unavailable'); /* Never expose secret-store failures. */ }
        checkAbort();
        if (!credential || !text(credential.accessToken) || credential.revoked || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now()) throw fail('credential_unavailable');
        const scopes = Array.isArray(credential.scopes) ? credential.scopes : [];
        if (!scopes.includes(scope)) throw fail('scope_missing');
        for (let attempt = 0; attempt < 2; attempt++) {
        checkAbort();
        if (credential.expiresAt <= Date.now()) throw fail('credential_unavailable');
        let response;
        try {
          response = await fetchImpl(`${ORIGIN}/openapi/v2${path}`, {
            method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
          });
        } catch { throw fail(controller.signal.aborted ? 'request_timeout' : 'network_error'); /* Do not retain request exceptions with credentials. */ }
        checkAbort();
        if (response.redirected || (response.url && new URL(response.url).origin !== ORIGIN)) throw fail('destination_rejected');
        if (response.status === 429 && !body && attempt === 0) {
          const raw = response.headers.get('retry-after');
          const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
          if (Number.isFinite(seconds) && seconds <= 5) {
            await response.body?.cancel();
            await wait(seconds * 1000);
            checkAbort();
            continue;
          }
        }
        if (!response.ok) throw fail(`http_${response.status}`);
        // Bound the decoded response independently of server Content-Length.
        let size = 0; const chunks = [];
        if (!response.body) throw fail('invalid_response');
        for await (const chunk of response.body) {
          checkAbort();
          size += chunk.byteLength;
          if (size > 1024 * 1024) { controller.abort(); throw fail('response_too_large'); }
          chunks.push(Buffer.from(chunk));
        }
        checkAbort();
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('invalid_response'); /* Server content never enters diagnostics. */ }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('invalid_response');
        if (parsed.code !== undefined && parsed.code !== 0) throw fail('api_error');
        return parsed.data ?? parsed;
        }
      })()]);
    } catch (error) {
      if (error?.message === `WorkBuddy: ${error?.code}`) throw error;
      throw fail(controller.signal.aborted ? 'request_timeout' : 'invalid_response');
    } finally { clearTimeout(timer); }
  }
  function authorized(input) { if (input?.authorized !== true) throw fail('authorization_required'); }
  function task(data) {
    if (!text(data.task_id) || !text(data.status)) throw fail('invalid_response');
    if (data.link !== undefined) {
      let url;
      try { url = new URL(data.link); } catch { throw fail('destination_rejected'); /* Invalid remote destination. */ }
      if (url.origin !== 'https://acp.workbuddy.cn' || url.username || url.password || url.search || url.hash || !/^\/sessions\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw fail('destination_rejected');
    }
    return { task_id: data.task_id, status: data.status, ...(text(data.name) ? { name: data.name } : {}) };
  }
  return Object.freeze({
    async localStatus() { const data = await request('/localassistant', 'user.localassistant.readable'); if (typeof data.online !== 'boolean') throw fail('invalid_response'); return { online: data.online }; },
    async sendLocal(input) { authorized(input); if (!text(input.content)) throw fail('invalid_params'); const data = await request('/localassistant/message', 'user.localassistant.invokable', { content: input.content, msg_type: 'text' }); if (!text(data.message_id) || data.message_id.length > 128) throw fail('invalid_response'); return { message_id: data.message_id }; },
    async localHistory(input = {}) {
      const params = new URLSearchParams();
      if (input.message_id !== undefined) { if (!text(input.message_id)) throw fail('invalid_params'); params.set('message_id', input.message_id); }
      else { const { limit = 20, offset = 0 } = input; if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw fail('invalid_params'); params.set('limit', limit); params.set('offset', offset); }
      const data = await request(`/localassistant/message?${params}`, 'user.localassistant.readable');
      if (!Array.isArray(data.messages) || data.messages.length > 100) throw fail('invalid_response');
      return { messages: data.messages.map(message => {
        if (!message || !text(message.message_id) || message.message_id.length > 128 || !['user', 'assistant'].includes(message.role) || !text(message.msg_type) || message.msg_type.length > 64 || typeof message.created_at !== 'string' || message.created_at.length > 64 || !Number.isFinite(Date.parse(message.created_at)) || !Array.isArray(message.content) || message.content.length > 100 || message.content.some(value => typeof value !== 'string' || value.length > 65536)) throw fail('invalid_response');
        return { message_id: message.message_id, role: message.role, content: [...message.content], msg_type: message.msg_type, created_at: message.created_at };
      }) };
    },
    async createTask(input) { authorized(input); if (!text(input.prompt) || (input.name !== undefined && !text(input.name))) throw fail('invalid_params'); return task(await request('/tasks', 'user.task.invokable', { prompt: input.prompt, ...(input.name !== undefined ? { name: input.name } : {}) })); },
    async getTask(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw fail('invalid_params'); return task(await request(`/tasks/${id}`, 'user.task.readable')); }
  });
}
