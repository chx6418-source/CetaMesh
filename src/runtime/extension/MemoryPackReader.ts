import type {MemoryPack} from '../../domain/extension/MemoryPack';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier} from '../../protocol/PairingProtocol';

export class MemoryPackReader {
  read(raw: string | unknown): MemoryPack {
    let value: unknown = raw;
    if (typeof raw === 'string') {
      if (raw.length > 1_048_576) { throw new CetaError('unsupported', 'Memory Pack is too large'); }
      try { value = JSON.parse(raw); } catch { throw new CetaError('invalid_protocol', 'Memory Pack is not valid JSON'); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new CetaError('invalid_protocol', 'Invalid Memory Pack'); }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => ['systemInstruction', 'script', 'code', 'executable'].includes(key)) || !record.manifest || !Array.isArray(record.memories) || !Array.isArray(record.entities) || !Array.isArray(record.relations) || record.memories.length > 1000 || record.entities.length > 1000 || record.relations.length > 5000) { throw new CetaError('unsupported', 'Memory Pack contains unsafe or oversized content'); }
    const manifest = record.manifest as Record<string, unknown>;
    if (typeof manifest.id !== 'string' || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') { throw new CetaError('invalid_protocol', 'Invalid Memory Pack manifest'); }
    identifier(manifest.id);
    const memories = record.memories.map(memory => {
      if (!memory || typeof memory !== 'object' || typeof (memory as Record<string, unknown>).id !== 'string' || typeof (memory as Record<string, unknown>).content !== 'string' || ((memory as Record<string, unknown>).content as string).length > 16_000 || !['local-only', 'my-devices'].includes((memory as Record<string, unknown>).scope as string)) { throw new CetaError('invalid_protocol', 'Invalid Memory Pack memory'); }
      const item = memory as {id: string; content: string; scope: 'local-only' | 'my-devices'};
      return {id: item.id, content: item.content, scope: item.scope};
    });
    return {manifest: {id: manifest.id, name: manifest.name, version: manifest.version}, memories, entities: record.entities as Record<string, unknown>[], relations: record.relations as Record<string, unknown>[], ...(typeof record.license === 'string' ? {license: record.license.slice(0, 200)} : {}), ...(record.signature && typeof record.signature === 'object' ? {signature: record.signature as Record<string, unknown>} : {}), origin: 'third_party', trust: 'untrusted', readOnly: true};
  }
}
