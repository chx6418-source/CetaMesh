import { CAPABILITY_EFFECTS, capabilityError } from './types.js';

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
      if (definition.effect !== undefined && !CAPABILITY_EFFECTS.includes(definition.effect)) {
        throw capabilityError('INVALID_CAPABILITY', 'Unknown capability effect');
      }
      for (const flag of ['readOnly', 'parallelSafe']) if (definition[flag] !== undefined && typeof definition[flag] !== 'boolean') {
        throw capabilityError('INVALID_CAPABILITY', flag + ' must be a boolean');
      }
      const readOnly = definition.readOnly === true;
      const parallelSafe = definition.parallelSafe === true;
      const cancellationMode = definition.cancellationMode ?? 'unknown';
      const timeoutMode = definition.timeoutMode ?? 'unknown';
      if (readOnly && definition.effect !== 'read-only') throw capabilityError('INVALID_CAPABILITY', 'readOnly requires a read-only effect');
      if (!['unknown', 'cooperative'].includes(cancellationMode) || !['unknown', 'await-settlement'].includes(timeoutMode)
        || (cancellationMode === 'cooperative' && definition.cancellationAware !== true)
        || (timeoutMode === 'await-settlement' && cancellationMode !== 'cooperative')) {
        throw capabilityError('INVALID_CAPABILITY', 'Invalid cancellation or timeout settlement contract');
      }
      // The current reviewed subset is exact Core Workspace IO. Provider tool
      // descriptions, category tags and request fields cannot opt into dispatch.
      if (parallelSafe && (!readOnly || definition.effect !== 'read-only' || definition.cancellationAware !== true
        || definition.cancellationMode !== 'cooperative' || definition.timeoutMode !== 'await-settlement'
        || !['filesystem.read', 'filesystem.search'].includes(id) || definition.provider !== 'workspace'
        || (definition.source !== undefined && definition.source !== 'workspace') || definition.catalogOwner)) {
        throw capabilityError('INVALID_CAPABILITY', 'Parallel execution requires the trusted Core Workspace read contract');
      }
      if (entries.has(id)) throw capabilityError('CAPABILITY_EXISTS', id);
      const risk = definition.risk ?? 'low';
      const entry = Object.freeze({
        ...definition,
        id,
        risk,
        readOnly,
        parallelSafe,
        cancellationMode,
        timeoutMode,
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
      readOnly: entry.readOnly,
      parallelSafe: entry.parallelSafe,
      cancellationMode: entry.cancellationMode,
      timeoutMode: entry.timeoutMode,
      ...(entry.effect ? { effect: entry.effect } : {}),
      ...(entry.descriptorVersion ? { descriptorVersion: entry.descriptorVersion } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.inputSchema ? { inputSchema: structuredClone(entry.inputSchema) } : {}),
      ...(typeof entry.category === 'string' ? { category: entry.category } : {})
    }))
  };
}
