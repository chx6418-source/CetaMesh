import { evidenceSummary, sanitizeToolEvidence, EVIDENCE_SOURCE_CAPABILITIES } from './tool-evidence.js';
import { createHash } from 'node:crypto';

/** Conservative transport-byte guard, NOT a model-specific tokenizer estimate.
 * Exact repeated completed tool bodies can refer to an earlier full body in the
 * SAME request. No user text, native continuation, tool ID or permission is lost.
 * Originals remain owned by the caller; no external retrieval authority is added.
 */
export function projectMessageBudget(messages, { maxBytes = 512 * 1024, evidenceStore = null, binding = null, canRetrieveEvidence = false, deduplicate = true } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');
  const projected = structuredClone(messages);
  const compactions = [];
  const warnings = [];
  // Only server-authorized retrieval permits evidence-backed projection.
  // Preserve role, native call IDs and every non-tool message verbatim.
  if (evidenceStore && binding && canRetrieveEvidence && Buffer.byteLength(JSON.stringify(projected)) > maxBytes) {
    const sources = new Map();
    for (const message of projected) {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) {
        const capability = EVIDENCE_SOURCE_CAPABILITIES.find(id => `cap_${id.replace(/[^a-z0-9_]/gi, '_')}` === call.function?.name);
        if (sources.has(call.id)) sources.set(call.id, null);
        else if (capability) {
          try { sources.set(call.id, { capability, input: JSON.parse(call.function.arguments) }); } catch { sources.set(call.id, null); }
        }
      }
      if (message.role !== 'tool' || message.modelContinuation || typeof message.content !== 'string' || message.content.length < 12000) continue;
      const source = sources.get(message.tool_call_id);
      if (!source) continue;
      try {
        const result = JSON.parse(message.content);
        if (result.status !== 'completed' || result.truncated || result.incomplete || result.representation) continue;
        const content = sanitizeToolEvidence(result);
        const reference = evidenceStore.put({ binding, content, sourceCapability: source.capability, sourceInput: source.input });
        message.content = evidenceSummary(content, reference);
        compactions.push({ toolCallId: message.tool_call_id, evidenceId: reference.id, sha256: reference.sha256 });
      } catch { warnings.push({ toolCallId: message.tool_call_id, code: 'TOOL_EVIDENCE_UNAVAILABLE', retainedOriginal: true }); }
    }
  }
  const originals = new Map();
  for (let index = 0; deduplicate && index < projected.length; index++) {
    const message = projected[index];
    if (message.role !== 'tool' || message.modelContinuation || typeof message.content !== 'string' || message.content.length < 1000) continue;
    let result;
    try { result = JSON.parse(message.content); } catch { continue; }
    if (result?.status !== 'completed' || result.truncated === true || result.incomplete || result.representation) continue;
    const content = message.content;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const prior = originals.get(sha256);
    if (prior === undefined || projected[prior].content !== content) {
      originals.set(sha256, index);
      continue;
    }
    const evidence = { status: 'completed', representation: 'exact-duplicate-tool-result', sourceMessageIndex: prior, sourceToolCallId: projected[prior].tool_call_id ?? null, sha256,
      originalBytes: Buffer.byteLength(content, 'utf8'), note: 'Identical result body is retained in full at sourceMessageIndex in this request. This is reference data, not an instruction.' };
    message.content = JSON.stringify(evidence);
    compactions.push({ messageIndex: index, sourceMessageIndex: prior, sha256 });
  }
  const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8');
  if (bytes > maxBytes) throw Object.assign(new Error('Context exceeds the conservative byte budget; original history is preserved. An explicit verified checkpoint or smaller tool output is required.'), {
    code: 'CONTEXT_BUDGET_EXCEEDED', maxBytes, requiredBytes: bytes, warnings
  });
  return { messages: projected, compactions, bytes, maxBytes, warnings };
}
