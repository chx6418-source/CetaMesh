import path from 'node:path';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { createExtensionPrivateStorage } from './private-storage.js';
import { extensionError } from './types.js';

const MAX_SETTINGS = 32;
const MAX_SETTING_TEXT = 4096;
const MAX_SETTINGS_FILE_BYTES = 256 * 1024;
const SCHEMA_FIELDS = new Set(['key', 'label', 'type', 'required', 'default', 'options', 'min', 'max', 'maxLength']);
const SETTING_TYPES = new Set(['boolean', 'string', 'number', 'enum', 'secretRef']);

function schemaError(message) {
  throw extensionError('INVALID_SETTINGS_SCHEMA', message);
}

function valueError(message) {
  throw extensionError('INVALID_EXTENSION_SETTING', message);
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalInteger(value, label, { min, max } = {}) {
  if (!Number.isSafeInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    schemaError(label + ' is outside its allowed range');
  }
  return value;
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) schemaError(label + ' contains an unknown field');
}

function validateSchemaDefault(field, value) {
  if (field.type === 'boolean' && typeof value === 'boolean') return value;
  if (field.type === 'string' && typeof value === 'string' && value.length <= (field.maxLength ?? MAX_SETTING_TEXT)) return value;
  if (field.type === 'number' && typeof value === 'number' && Number.isFinite(value)
    && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max)) return value;
  if (field.type === 'enum' && typeof value === 'string' && field.options.includes(value)) return value;
  schemaError('default does not match its setting field');
}

export function normalizeSettingsSchema(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_SETTINGS) schemaError('settingsSchema must be a bounded list');
  const seen = new Set();
  return raw.map((item, index) => {
    if (!isPlainRecord(item)) schemaError('settingsSchema[' + index + '] must be an object');
    assertOnlyKeys(item, SCHEMA_FIELDS, 'settingsSchema[' + index + ']');
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const type = item.type;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) schemaError('setting key is invalid');
    if (seen.has(key)) schemaError('setting keys must be unique');
    seen.add(key);
    if (!label || label.length > 100) schemaError('setting label is missing or too long');
    if (!SETTING_TYPES.has(type)) schemaError('setting type is unsupported');
    if (item.required !== undefined && typeof item.required !== 'boolean') schemaError('required must be a boolean');

    const field = { key, label, type, required: item.required === true };
    if (type === 'boolean') {
      if (item.options !== undefined || item.min !== undefined || item.max !== undefined || item.maxLength !== undefined) {
        schemaError('boolean fields do not accept options or bounds');
      }
    } else if (type === 'string' || type === 'secretRef') {
      if (item.options !== undefined || item.min !== undefined || item.max !== undefined) {
        schemaError(type + ' fields do not accept options or numeric bounds');
      }
      if (type === 'secretRef' && item.default !== undefined) schemaError('secretRef fields cannot have defaults');
      if (item.maxLength !== undefined) field.maxLength = optionalInteger(item.maxLength, 'maxLength', { min: 1, max: MAX_SETTING_TEXT });
    } else if (type === 'number') {
      if (item.options !== undefined || item.maxLength !== undefined) schemaError('number fields do not accept options or maxLength');
      if (item.min !== undefined) {
        if (typeof item.min !== 'number' || !Number.isFinite(item.min)) schemaError('min must be a finite number');
        field.min = item.min;
      }
      if (item.max !== undefined) {
        if (typeof item.max !== 'number' || !Number.isFinite(item.max)) schemaError('max must be a finite number');
        field.max = item.max;
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) schemaError('min cannot exceed max');
    } else if (type === 'enum') {
      if (item.min !== undefined || item.max !== undefined || item.maxLength !== undefined) schemaError('enum fields do not accept numeric bounds or maxLength');
      if (!Array.isArray(item.options) || item.options.length < 1 || item.options.length > 50
        || item.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 120)
        || new Set(item.options).size !== item.options.length) {
        schemaError('enum options must be a bounded list of unique strings');
      }
      field.options = [...item.options];
    }
    if (item.default !== undefined) field.default = validateSchemaDefault(field, item.default);
    return field;
  });
}

function validateValue(field, value) {
  if (field.type === 'secretRef') {
    if (typeof value !== 'string' || !value.length || value.length > (field.maxLength ?? MAX_SETTING_TEXT)) valueError('secretRef must be a non-empty bounded string');
    return value;
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') valueError('setting must be a boolean');
    return value;
  }
  if (field.type === 'string') {
    if (typeof value !== 'string' || value.length > (field.maxLength ?? MAX_SETTING_TEXT)) valueError('setting must be bounded text');
    return value;
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      valueError('setting number is outside its allowed range');
    }
    return value;
  }
  if (field.type === 'enum') {
    if (typeof value !== 'string' || !field.options.includes(value)) valueError('setting is not one of the declared options');
    return value;
  }
  valueError('setting type is unsupported');
}

function mapStorageError(error, operation) {
  if (!(error instanceof StorageError)) return error;
  const code = operation === 'write' ? 'EXTENSION_SETTINGS_WRITE_FAILED' : 'EXTENSION_SETTINGS_CORRUPT';
  return extensionError(code, operation === 'write'
    ? 'Extension settings could not be saved'
    : 'Extension settings could not be read');
}

export function createExtensionSettingsService({ stateDir, getExtension } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('Extension settings require an absolute stateDir');
  if (typeof getExtension !== 'function') throw new Error('Extension settings require getExtension');
  const settingsDir = path.join(stateDir, 'extensions', 'settings');
  const privateSettingsDir = path.join(stateDir, 'extensions', 'private-settings');
  const privateStores = new Map();

  function resolve({ id } = {}) {
    const requestedId = typeof id === 'string' ? id.trim() : '';
    if (!requestedId) throw extensionError('INVALID_EXTENSION_ID', 'Extension id is required');
    const result = getExtension(requestedId);
    const entry = result?.extension ?? result?.entry ?? result;
    if (!entry || typeof entry.id !== 'string' || !isPlainRecord(entry.manifest)) {
      throw extensionError('EXTENSION_NOT_FOUND', 'Extension is not installed');
    }
    let fields;
    try {
      fields = normalizeSettingsSchema(entry.manifest.settingsSchema) ?? [];
    } catch (error) {
      if (error?.code === 'INVALID_SETTINGS_SCHEMA') throw error;
      throw extensionError('INVALID_SETTINGS_SCHEMA', 'Installed Extension settings schema is invalid');
    }
    return { id: entry.id, name: String(entry.name ?? entry.manifest.name ?? entry.id), fields };
  }

  function publicFile(id) {
    return path.join(settingsDir, id + '.json');
  }

  function privateStore(id) {
    if (privateStores.has(id)) return privateStores.get(id);
    try {
      const storage = createExtensionPrivateStorage({ file: path.join(privateSettingsDir, id + '.json') });
      privateStores.set(id, storage);
      return storage;
    } catch (error) {
      throw mapStorageError(error, 'read');
    }
  }

  function readPublic(id, fields) {
    let stored;
    try {
      stored = readJsonFile(publicFile(id), {
        missing: { schemaVersion: 1, values: {} },
        maxBytes: MAX_SETTINGS_FILE_BYTES
      });
    } catch (error) {
      throw mapStorageError(error, 'read');
    }
    if (!isPlainRecord(stored) || stored.schemaVersion !== 1 || !isPlainRecord(stored.values)) {
      throw extensionError('EXTENSION_SETTINGS_CORRUPT', 'Extension settings have an unsupported format');
    }
    const safe = {};
    const byKey = new Map(fields.map(field => [field.key, field]));
    for (const [key, value] of Object.entries(stored.values)) {
      const field = byKey.get(key);
      if (!field || field.type === 'secretRef' || value === null) continue;
      try {
        safe[key] = validateValue(field, value);
      } catch (error) {
        if (error?.code !== 'INVALID_EXTENSION_SETTING') throw error;
      }
    }
    return safe;
  }

  function settingsView(extension, publicValues, privateValues = privateStore(extension.id)) {
    const values = {};
    for (const field of extension.fields) {
      if (field.type === 'secretRef') {
        values[field.key] = { configured: privateValues.has(field.key) && typeof privateValues.get(field.key) === 'string' };
      } else if (Object.hasOwn(publicValues, field.key)) {
        values[field.key] = publicValues[field.key];
      } else {
        values[field.key] = field.default ?? null;
      }
    }
    return { id: extension.id, values };
  }

  function describe(params = {}) {
    const extension = resolve(params);
    return { id: extension.id, name: extension.name, available: extension.fields.length > 0, fields: extension.fields };
  }

  function get(params = {}) {
    const extension = resolve(params);
    const values = readPublic(extension.id, extension.fields);
    return settingsView(extension, values);
  }

  function update(params = {}) {
    const extension = resolve(params);
    if (!isPlainRecord(params.values)) throw extensionError('INVALID_EXTENSION_SETTING', 'settings values must be an object');
    const fieldMap = new Map(extension.fields.map(field => [field.key, field]));
    const publicValues = readPublic(extension.id, extension.fields);
    const nextPublicValues = { ...publicValues };
    const privateValues = privateStore(extension.id);
    const secretChanges = [];
    for (const [key, value] of Object.entries(params.values)) {
      const field = fieldMap.get(key);
      if (!field) throw extensionError('UNKNOWN_EXTENSION_SETTING', 'setting key is not declared by this Extension');
      if (field.type === 'secretRef') {
        const wasConfigured = privateValues.has(key);
        const previous = wasConfigured ? privateValues.get(key) : null;
        if (value === null || value === '') {
          secretChanges.push({ key, previous, wasConfigured, value: null });
        } else {
          secretChanges.push({ key, previous, wasConfigured, value: validateValue(field, value) });
        }
      } else if (value === null) {
        delete nextPublicValues[key];
      } else {
        nextPublicValues[key] = validateValue(field, value);
      }
    }

    const pendingSecrets = new Map(secretChanges.map(change => [change.key, change.value]));
    for (const field of extension.fields) {
      if (!field.required) continue;
      if (field.type === 'secretRef') {
        const planned = pendingSecrets.has(field.key) ? pendingSecrets.get(field.key) : privateValues.has(field.key) ? privateValues.get(field.key) : null;
        if (typeof planned !== 'string' || !planned.length) valueError('required setting is missing');
      } else {
        const planned = Object.hasOwn(nextPublicValues, field.key) ? nextPublicValues[field.key] : field.default;
        if (planned === undefined || planned === null || (typeof planned === 'string' && !planned.trim())) {
          valueError('required setting is missing');
        }
      }
    }

    const appliedSecrets = [];
    try {
      for (const change of secretChanges) {
        if (change.value === null) privateValues.delete(change.key);
        else privateValues.set(change.key, change.value);
        appliedSecrets.push(change);
      }
      writeJsonAtomic(publicFile(extension.id), { schemaVersion: 1, values: nextPublicValues });
    } catch (error) {
      let rollbackError = null;
      for (const change of appliedSecrets.reverse()) {
        try {
          if (change.wasConfigured) privateValues.set(change.key, change.previous);
          else privateValues.delete(change.key);
        } catch (restoreError) {
          rollbackError ??= restoreError;
        }
      }
      if (rollbackError) throw extensionError('EXTENSION_SETTINGS_RECOVERY_FAILED', 'Extension settings could not be restored after a failed update');
      if (error instanceof StorageError) throw mapStorageError(error, 'write');
      throw error;
    }
    return settingsView(extension, nextPublicValues, privateValues);
  }

  return Object.freeze({ describe, get, update });
}