// Review aids for pending candidates only. Callers must supply currently eligible,
// authorized records of the same Scope/type. These rules never decide truth,
// manufacture fact identity, or change retrieval, confirmation or stored records.
const MAX_HINTS = 5;

function normalizedText(content) {
  return content.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function simpleAttribute(content) {
  // Deliberately abstain on general prose, negation, questions and alternatives.
  if (content.length > 240 || /[\r\n]/u.test(content)) return null;
  const text = normalizedText(content).replace(/[.。]$/u, '');
  if (/\b(?:not|no|never|maybe|perhaps|probably|possibly|if|unless|when|while|either|or|and|but|was|were|will|would|could|should|may|might|for|as|today|yesterday|previously|formerly|according|except)\b/u.test(text)
    || /不|没|未|可能|也许|或许|如果|假如|例如|比如|或者|以及|但是|曾经|以前|之前|将来|大概|据说|并且|和|与|或|视情况|取决于/u.test(text)
    || /\.\s/u.test(text)) return null;
  const parts = text.match(/^([\p{L}\p{N}][\p{L}\p{N} _-]{0,79}) is ([\p{L}\p{N}][\p{L}\p{N} ._/:+-]{0,119})$/u)
    ?? text.match(/^([\p{L}\p{N}][\p{L}\p{N} _-]{0,79})是([\p{L}\p{N}][\p{L}\p{N} ._/:+-]{0,119})$/u);
  if (!parts) return null;
  const subject = parts[1].trim(), value = parts[2].trim();
  if (!/(?:\b(?:command|version|language|timezone|time zone|channel|port|format|color|colour|theme)|命令|版本|语言|时区|通道|端口|格式|颜色|主题)$/u.test(subject)
    || /\bis\b|是/u.test(value)) return null;
  return { subject, value };
}

/** A transient index for one authorized candidate projection, never persisted. */
export function createCandidateReviewer(records) {
  const byText = new Map(), bySubject = new Map();
  for (const record of records) {
    const text = normalizedText(record.content);
    const item = { memoryId: record.id, revision: record.rev, assertion: simpleAttribute(record.content) };
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(item);
    if (item.assertion) {
      if (!bySubject.has(item.assertion.subject)) bySubject.set(item.assertion.subject, []);
      bySubject.get(item.assertion.subject).push(item);
    }
  }
  return (content) => {
    const text = normalizedText(content), assertion = simpleAttribute(content);
    const duplicates = byText.get(text) ?? [];
    const conflicts = assertion ? (bySubject.get(assertion.subject) ?? [])
      .filter(item => item.assertion.value !== assertion.value) : [];
    const hints = [
      ...duplicates.map(item => ({ kind: 'possible-duplicate', code: 'normalized-text-match', memoryId: item.memoryId, revision: item.revision })),
      ...conflicts.map(item => ({ kind: 'possible-conflict', code: 'same-subject-different-value', memoryId: item.memoryId, revision: item.revision }))
    ].sort((a, b) => a.memoryId.localeCompare(b.memoryId));
    return hints.length ? {
      status: 'needs-review', method: 'deterministic-text-v1', hints: hints.slice(0, MAX_HINTS), truncated: hints.length > MAX_HINTS
    } : undefined;
  };
}
