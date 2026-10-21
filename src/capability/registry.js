import { capabilityError } from './types.js';

function schemaOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : null;
}

export function createCapabilityRegistry() {
  const entries = new Map();
  return {
    register(definition) {
      if (!definition?.id || typeof definition.execute !== 'function') {
        throw capabilityError('INVALID_CAPABILITY', 'id and execute required');
      }
      const id = String(definition.id).trim();
      if (entries.has(id)) throw capabilityError('CAPABILITY_EXISTS', id);
      const risk = definition.risk ?? 'low';
      const entry = Object.freeze({
        ...definition,
        id,
        risk,
        available: definition.available !== false,
        requiresApproval: definition.requiresApproval === true || ['high', 'critical'].includes(risk),
        description: typeof definition.description === 'string' ? definition.description.trim() : '',
        inputSchema: schemaOf(definition.inputSchema)
      });
      entries.set(id, entry);
      return id;
    },
    require(id) {
      const entry = entries.get(id);
      if (!entry) throw capabilityError('UNKNOWN_CAPABILITY', 'Unknown capability: ' + id);
      return entry;
    },
    has: (id) => entries.has(id),
    // Synchronous transaction: callers only replace descriptors they own.
    replaceProviderEntries(catalogOwner, definitions) {
      if (typeof catalogOwner !== 'string' || !catalogOwner) throw capabilityError('INVALID_CAPABILITY', 'Catalog owner required');
      const replacement = createCapabilityRegistry();
      for (const definition of definitions) {
        if (definition.catalogOwner !== catalogOwner) throw capabilityError('INVALID_CAPABILITY', 'Catalog owner mismatch');
        if (entries.has(definition.id) && entries.get(definition.id).catalogOwner !== catalogOwner) throw capabilityError('CAPABILITY_EXISTS', definition.id);
        replacement.register(definition);
      }
      // Validate the entire replacement before mutating the authoritative map.
      for (const [id, entry] of entries) if (entry.catalogOwner === catalogOwner) entries.delete(id);
      for (const definition of definitions) entries.set(definition.id, replacement.require(definition.id));
    },
    list: () => [...entries.values()].map((entry) => ({
      id: entry.id,
      permission: entry.permission ?? entry.id,
      risk: entry.risk,
      provider: entry.provider ?? 'adapter',
      source: entry.source ?? entry.provider ?? 'adapter',
      workspace: entry.workspace === true,
      requiresTask: entry.requiresTask === true,
      available: entry.available === true,
      availability: typeof entry.availability === 'string' ? entry.availability : (entry.available === true ? 'available' : 'unavailable'),
      requiresApproval: entry.requiresApproval === true,
      modelCallable: entry.modelCallable !== false,
      ...(entry.descriptorVersion ? { descriptorVersion: entry.descriptorVersion } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.inputSchema ? { inputSchema: structuredClone(entry.inputSchema) } : {}),
      ...(typeof entry.category === 'string' ? { category: entry.category } : {})
    }))
  };
}
