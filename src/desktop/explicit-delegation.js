// Only a direct, terminal imperative in the Owner's message selects an executor.
// Quoted/reference text and mere mentions never create execution authority.
export function explicitDelegationTarget(text) {
  if (typeof text !== 'string' || /[“”‘’\x22\x60]/u.test(text)) return null;
  return /(?:^|[，,。；;\n])\s*(?:请)?交给\s*codex(?:\s*执行)?[。.!！]?\s*$/iu.test(text) ? 'codex' : null;
}
