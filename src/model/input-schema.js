import { capabilityError } from '../capability/types.js';
function fail(code, message) { throw capabilityError(code, message); }

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export function validateSchema(schema, value, location = '$', depth = 0) {
  if (depth > 8 || !schema || typeof schema !== 'object') fail('TOOL_ARGUMENTS_INVALID', `${location}: invalid schema`);
  // JSON Schema nullable primitives; keep all non-null constraints intact.
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter(type => type !== 'null');
    if (types.length !== 1) fail('TOOL_ARGUMENTS_INVALID', location + ': unsupported union');
    return validateSchema({ ...schema, type: value === null && schema.type.includes('null') ? 'null' : types[0] }, value, location, depth);
  }
  const type = schema.type;
  const validType = type === 'object' ? isPlainObject(value)
    : type === 'array' ? Array.isArray(value)
      : type === 'string' ? typeof value === 'string'
        : type === 'integer' ? Number.isSafeInteger(value)
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : type === 'boolean' ? typeof value === 'boolean'
              : type === 'null' ? value === null : false;
  if (!validType) fail('TOOL_ARGUMENTS_INVALID', `${location}: expected ${String(type)}`);
  if (type === 'object') {
    if (Object.keys(value).length > Math.min(schema.maxProperties ?? 64, 64)) fail('TOOL_ARGUMENTS_INVALID', `${location}: too many properties`);
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) fail('TOOL_ARGUMENTS_INVALID', `${location}.${name}: required`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, name)) {
        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          validateSchema(schema.additionalProperties, child, `${location}.${name}`, depth + 1);
        } else if (schema.additionalProperties === true) {
          validateJsonValue(child, `${location}.${name}`, depth + 1);
        } else fail('TOOL_ARGUMENTS_INVALID', `${location}.${name}: unexpected property`);
        continue;
      }
      validateSchema(properties[name], child, `${location}.${name}`, depth + 1);
    }
  } else if (type === 'array') {
    if (value.length > 256) fail('TOOL_ARGUMENTS_INVALID', `${location}: too many items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) fail('TOOL_ARGUMENTS_INVALID', `${location}: too many items`);
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) fail('TOOL_ARGUMENTS_INVALID', `${location}: too few items`);
    if (schema.items) value.forEach((child, index) => validateSchema(schema.items, child, `${location}[${index}]`, depth + 1));
  } else if (type === 'string') {
    if (value.length > 65536) fail('TOOL_ARGUMENTS_INVALID', `${location}: too long`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) fail('TOOL_ARGUMENTS_INVALID', `${location}: too long`);
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) fail('TOOL_ARGUMENTS_INVALID', `${location}: too short`);
  } else if (type === 'number' || type === 'integer') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) fail('TOOL_ARGUMENTS_INVALID', `${location}: below minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) fail('TOOL_ARGUMENTS_INVALID', `${location}: above maximum`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail('TOOL_ARGUMENTS_INVALID', `${location}: value is not allowed`);
}

// Explicit additionalProperties permits only bounded JSON, never unchecked objects.
function validateJsonValue(value, location, depth) {
  if (depth > 8) fail('TOOL_ARGUMENTS_INVALID', `${location}: nested input too deep`);
  if (value === null || typeof value === 'boolean') return;
  const type = Array.isArray(value) ? 'array' : typeof value;
  if (type === 'number' || type === 'string') { validateSchema({type}, value, location, depth); return; }
  if (type === 'array') {
    if (value.length > 256) fail('TOOL_ARGUMENTS_INVALID', `${location}: too many items`);
    value.forEach((item,index) => validateJsonValue(item, `${location}[${index}]`, depth + 1));
    return;
  }
  validateSchema({type:'object',additionalProperties:true,maxProperties:64}, value, location, depth);
}
