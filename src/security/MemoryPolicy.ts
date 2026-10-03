import type { MemoryInput, MemoryPatch } from '../domain/memory/Memory';
import {
  invalidMemory,
  normalizeMemory,
  validatePatch,
} from '../domain/memory/MemoryValidation';
// Conservative local protection. Arbitrary unlabelled secrets cannot be inferred.
export function isSensitiveMemoryText(text: string): boolean {
  return /(?:api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|password|密码|口令|私钥|pairing[\s_-]?secret)\s*(?:[:=：]|是|is\b)\s*\S+|\b(?:sk-|sk_live_|ghp_|github_pat_)\S{8,}|-----BEGIN[^\n]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(
    text,
  );
}
export class MemoryPolicy {
  save(input: MemoryInput): Required<MemoryInput> {
    const value = normalizeMemory(input);
    if (isSensitiveMemoryText(value.content)) {
      return invalidMemory();
    }
    return value;
  }
  update(input: MemoryPatch): MemoryPatch {
    const value = validatePatch(input);
    if (value.content !== undefined && isSensitiveMemoryText(value.content)) {
      return invalidMemory();
    }
    return value;
  }
}
