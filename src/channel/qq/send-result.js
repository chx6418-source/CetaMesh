export function interpretQqDataSendResponse(response) {
  const body = response?.json;
  const data = body?.data;
  if (body?.code === 'QQ_OUTCOME_UNKNOWN' || data?.status === 'outcome-unknown') {
    throw Object.assign(new Error('QQ send outcome unknown; verify the original request before retrying'),
      { code: 'QQ_OUTCOME_UNKNOWN', requestId: body?.requestId ?? data?.requestId });
  }
  if (!response?.ok || body?.ok === false) {
    throw Object.assign(new Error(body?.error || `QQ send host rejected request (${response?.status ?? 0})`),
      { code: body?.code ?? 'QQ_SEND_REJECTED' });
  }
  if (data?.duplicate) {
    if (data.status !== 'sent' || !data.receipt) {
      throw Object.assign(new Error('QQ send result still needs verification'),
        { code: 'QQ_OUTCOME_UNKNOWN', requestId: data.requestId });
    }
    return { ...data.receipt, duplicate: true };
  }
  return data;
}
