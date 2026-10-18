function deny(code, message) {
  throw Object.assign(new Error(message), { code });
}

function allowTarget(target, config) {
  const match = /^(group|private):([1-9]\d*)$/.exec(String(target ?? ''));
  if (!match) return false;
  const kind = match[1];
  const id = match[2];
  const denyList = config?.deny?.[kind] ?? config?.deny?.[kind + 's'] ?? [];
  if (!Array.isArray(denyList) || denyList.map(String).includes(id)) return false;
  const allowList = config?.allow?.[kind] ?? config?.allow?.[kind + 's'] ?? [];
  if (!Array.isArray(allowList)) return false;
  return allowList.length ? allowList.map(String).includes(id) : config?.allowAllWhenEmpty === true;
}

export function assertQqSendPolicy(request, { config = {}, qqEnabled = false, bionicEnabled = false,
  toolEnabled = () => { deny('QQ_TOOL_UNVERIFIED', 'QQ tool authorization unavailable'); } } = {}) {
  if (!qqEnabled) deny('QQ_DISABLED', 'QQ Connector disabled');
  const { accountId, target, kind, toolName, mediaAuthorized, approvalVerified } = request ?? {};
  if (!/^\d{1,20}$/.test(String(accountId ?? ''))) deny('QQ_ACCOUNT_UNVERIFIED', 'QQ account identity unavailable');
  if (kind === 'custom-face') {
    if (target !== `private:${accountId}`) deny('QQ_TARGET_DENIED', 'custom-face action must target the current account');
  } else if (!allowTarget(target, config)) {
    deny('QQ_TARGET_DENIED', 'QQ send target is not allowlisted');
  }
  if (kind === 'text') return true;
  if (['file', 'audio', 'music'].includes(kind)) {
    const expected = kind === 'file' ? 'qq_send_file' : 'qq_send_audio_from_url';
    if (toolName !== expected && !(kind === 'audio' && toolName === 'qq_send_file')) {
      deny('QQ_MEDIA_PERMISSION_REQUIRED', `QQ ${kind} requires a matching media tool`);
    }
    toolEnabled(toolName);
    return true;
  }
  if (kind === 'sticker') {
    if (!bionicEnabled) deny('QQ_BIONIC_DISABLED', 'Bionic Chat disabled');
    if (!mediaAuthorized || toolName !== 'qq_send_sticker' || config?.socialV2?.sticker?.enabled === false) {
      deny('QQ_MEDIA_PERMISSION_REQUIRED', 'QQ sticker needs explicit media authorization');
    }
    toolEnabled(toolName);
    return true;
  }
  if (kind === 'card') {
    if (!bionicEnabled) deny('QQ_BIONIC_DISABLED', 'Bionic Chat disabled');
    if (!approvalVerified) deny('QQ_APPROVAL_REQUIRED', 'QQ card action requires verified approval or low-risk decision');
    return true;
  }
  if (kind === 'poke') {
    if (!bionicEnabled) deny('QQ_BIONIC_DISABLED', 'Bionic Chat disabled');
    if (toolName !== 'qq_send_poke') deny('QQ_MEDIA_PERMISSION_REQUIRED', 'QQ poke tool authorization missing');
    toolEnabled(toolName);
    return true;
  }
  if (kind === 'custom-face') {
    if (!bionicEnabled) deny('QQ_BIONIC_DISABLED', 'Bionic Chat disabled');
    if (!mediaAuthorized || !['qq_set_sticker_remark', 'qq_collect_sticker'].includes(toolName) ||
        config?.socialV2?.sticker?.enabled === false) {
      deny('QQ_MEDIA_PERMISSION_REQUIRED', 'QQ custom-face tool authorization missing');
    }
    toolEnabled(toolName);
    return true;
  }
  deny('QQ_MEDIA_UNSUPPORTED', 'QQ message type is not supported');
}
