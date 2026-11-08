// Optional Desktop Worker v1 profile. No credentials or store paths cross it.
import { extensionError } from './types.js';
import { extensionSettingsBinding, normalizeSettingsSchema, publicSettingsRevision, validateSettingValue } from './settings.js';

export function validateSettingsConfiguration(configuration, manifest, packageFingerprint) {
  const fail = () => { throw extensionError('EXTENSION_SETTINGS_ACK_MISMATCH', 'Configuration does not match the reviewed package and schema'); };
  if (!configuration || configuration.profile !== 'public-settings-v1'
    || Object.keys(configuration).some(key => !['profile', 'id', 'version', 'packageFingerprint', 'schemaFingerprint', 'revision', 'generation', 'values'].includes(key))
    || !Number.isSafeInteger(configuration.generation) || configuration.generation < 1
    || !configuration.values || typeof configuration.values !== 'object' || Array.isArray(configuration.values)
    || Buffer.byteLength(JSON.stringify(configuration), 'utf8') > 160 * 1024) fail();
  const binding = extensionSettingsBinding({ id: manifest.id, version: manifest.version, manifest, packageFingerprint });
  for (const key of Object.keys(binding)) if (configuration[key] !== binding[key]) fail();
  const fields = normalizeSettingsSchema(manifest.settingsSchema) ?? [];
  const publicFields = fields.filter(field => field.type !== 'secretRef');
  if (Object.keys(configuration.values).length !== publicFields.length) fail();
  const values = {};
  for (const field of publicFields) {
    if (!Object.hasOwn(configuration.values, field.key)) fail();
    const value = configuration.values[field.key];
    if (value === null && !field.required) values[field.key] = null;
    else {
      try { values[field.key] = validateSettingValue(field, value); } catch { fail(); }
      if (field.required && value === '') fail();
    }
  }
  if (configuration.revision !== publicSettingsRevision(binding, values)) fail();
  return { values: Object.freeze(values), receipt: Object.freeze({ profile: configuration.profile, ...binding,
    revision: configuration.revision, generation: configuration.generation }) };
}

export function settingsReceiptMatches(receipt, configuration) {
  return receipt && ['profile', 'id', 'version', 'packageFingerprint', 'schemaFingerprint', 'revision', 'generation']
    .every(key => receipt[key] === configuration[key]);
}
