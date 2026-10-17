// Bind Workshop identity only to a private QQ transport route. A group reply is
// visible to other members and may carry a proposal id or approved artifact.
export function workshopQqIngress({ kind, id, senderId } = {}) {
  if (kind !== 'private') return { accepted: false, code: 'PRIVATE_REQUIRED' };
  const route = String(id ?? '');
  const sender = String(senderId ?? '');
  if (!/^[1-9]\d*$/.test(route) || route !== sender) return { accepted: false, code: 'ACTOR_MISMATCH' };
  return { accepted: true, actor: { kind: 'external', id: `qq:${route}` } };
}
