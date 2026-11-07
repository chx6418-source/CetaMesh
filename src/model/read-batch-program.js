import { capabilityError } from '../capability/types.js';

export const READ_BATCH_LIMITS = Object.freeze({ steps: 8, items: 8, readBytes: 50000,
  totalReadBytes: 512 * 1024, rows: 2000, lineChars: 8000, outputChars: 12000, planChars: 32000 });
const operations = ['search', 'read', 'readEach', 'lines', 'filter', 'select', 'sort', 'unique', 'aggregate'];
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const fail = message => { throw capabilityError('READ_BATCH_INVALID', message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const text = (value, maximum = 1000) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
function keys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key) || unsafe.has(key))) fail('Unexpected program fields');
}
function field(value) {
  if (!text(value, 160) || !value.split('.').every(part => /^[A-Za-z_][A-Za-z0-9_-]{0,59}$/.test(part) && !unsafe.has(part))
    || value.split('.').length > 4) fail('Only bounded own-property field selectors are supported');
  return value;
}
function fields(value) {
  if (!Array.isArray(value) || !value.length || value.length > 12) fail('A projection needs one to twelve fields');
  return value.map(field);
}
function relative(value, { directory = false } = {}) {
  if (!text(value) || /[\x00-\x1f:*?]/.test(value) || value.startsWith('/') || value.startsWith('\\')
    || value.replaceAll('\\', '/').split('/').some(part => !part || part === '..' || (part === '.' && !(directory && value === '.')))) fail('Source paths must be Workspace-relative');
  return value;
}
function reference(value, earlier) { if (!text(value, 40) || !earlier.has(value)) fail('Sources must reference an earlier step'); return value; }

// The schema is a model-facing description. validateReadBatchPlan is the full
// audited interpreter grammar and runs for the entire plan before any source IO.
export const READ_BATCH_INPUT_SCHEMA = Object.freeze({ type: 'object', required: ['version', 'steps', 'output'], additionalProperties: false,
  properties: { version: { type: 'integer', enum: [1] }, steps: { type: 'array', minItems: 1, maxItems: 8,
    items: { type: 'object', required: ['id', 'op'], additionalProperties: false, properties: {
      id: { type: 'string', maxLength: 40 }, op: { type: 'string', enum: operations },
      input: { type: 'object', additionalProperties: true }, from: { type: 'string' }, pathField: { type: 'string' }, maxItems: { type: 'integer', minimum: 1, maximum: 8 },
      maxBytes: { type: 'integer', minimum: 1, maximum: 50000 }, format: { type: 'string', enum: ['text', 'jsonl'] },
      fields: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 }, where: { type: 'object', additionalProperties: true },
      field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] }, groupBy: { type: 'string' },
      measures: { type: 'array', items: { type: 'string', enum: ['count'] }, minItems: 1, maxItems: 1 }
    } } }, output: { type: 'object', required: ['from'], additionalProperties: false, properties: {
      from: { type: 'string' }, fields: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 } } } } });

export function validateReadBatchPlan(input) {
  keys(input, ['version', 'steps', 'output']);
  let serialized;
  try { serialized = JSON.stringify(input); } catch { fail('The program must be JSON'); }
  if (input.version !== 1 || serialized.length > READ_BATCH_LIMITS.planChars || !Array.isArray(input.steps)
    || !input.steps.length || input.steps.length > READ_BATCH_LIMITS.steps) fail('Program version or bounds are invalid');
  const earlier = new Set();
  const steps = input.steps.map(step => {
    if (!plain(step) || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(step.id ?? '') || earlier.has(step.id)
      || !operations.includes(step.op)) fail('Step identity or operation is invalid');
    const value = structuredClone(step);
    if (step.op === 'search' || step.op === 'read') {
      keys(step, ['id', 'op', 'input']);
      keys(step.input, step.op === 'search' ? ['path', 'query', 'glob', 'limit'] : ['path', 'pathRef', 'maxBytes', 'offset']);
      if (step.op === 'search') {
        relative(step.input.path ?? '.', { directory: true });
        if (!text(step.input.query ?? step.input.glob) || (step.input.query !== undefined && !text(step.input.query))
          || (step.input.glob !== undefined && (!text(step.input.glob, 160) || /[\\:\x00-\x1f]/.test(step.input.glob)
            || step.input.glob.split('/').some(part => !part || part === '..')))) fail('Search needs bounded query or glob');
        if (!step.input.query && !step.input.glob?.split(/[*?/]+/).some(part => part.trim())) fail('A glob search requires a literal candidate query');
        if (step.input.limit !== undefined && !integer(step.input.limit, 1, READ_BATCH_LIMITS.items)) fail('Search item limit exceeded');
      } else {
        if ((step.input.path === undefined) === (step.input.pathRef === undefined)) fail('Read needs exactly one path or pathRef');
        if (step.input.path !== undefined) relative(step.input.path);
        if (step.input.pathRef !== undefined) {
          keys(step.input.pathRef, ['from', 'field', 'index']);
          reference(step.input.pathRef.from, earlier); field(step.input.pathRef.field);
          if (!integer(step.input.pathRef.index ?? 0, 0, READ_BATCH_LIMITS.items - 1)) fail('Read reference index exceeded');
        }
        if (step.input.maxBytes !== undefined && !integer(step.input.maxBytes, 1, READ_BATCH_LIMITS.readBytes)) fail('Source read cap exceeded');
        if (step.input.offset !== undefined && !integer(step.input.offset, 0, Number.MAX_SAFE_INTEGER)) fail('Source offset invalid');
      }
    } else {
      reference(step.from, earlier);
      const properties = { readEach: ['pathField', 'maxItems', 'maxBytes'], lines: ['format'], filter: ['where'],
        select: ['fields'], sort: ['field', 'direction'], unique: ['field'], aggregate: ['groupBy', 'measures'] }[step.op];
      keys(step, ['id', 'op', 'from', ...properties]);
      if (step.op === 'readEach') {
        field(step.pathField);
        if (!integer(step.maxItems ?? READ_BATCH_LIMITS.items, 1, READ_BATCH_LIMITS.items)
          || !integer(step.maxBytes ?? READ_BATCH_LIMITS.readBytes, 1, READ_BATCH_LIMITS.readBytes)) fail('Fanout or byte cap exceeded');
      }
      if (step.op === 'lines' && !['text', 'jsonl'].includes(step.format)) fail('Line format invalid');
      if (step.op === 'select') fields(step.fields);
      if (step.op === 'filter') {
        keys(step.where, ['field', 'op', 'value']); field(step.where.field);
        if (!['eq', 'contains', 'startsWith'].includes(step.where.op)
          || !['string', 'number', 'boolean'].includes(typeof step.where.value) && step.where.value !== null
          || typeof step.where.value === 'string' && step.where.value.length > 1000
          || typeof step.where.value === 'number' && !Number.isFinite(step.where.value)) fail('Filter predicate invalid');
      }
      if (step.op === 'unique' || step.op === 'sort') field(step.field);
      if (step.op === 'sort' && !['asc', 'desc'].includes(step.direction ?? 'asc')) fail('Sort direction invalid');
      if (step.op === 'aggregate') {
        if (step.groupBy !== undefined) field(step.groupBy);
        if (!Array.isArray(step.measures) || step.measures.length !== 1 || step.measures[0] !== 'count') fail('Only count aggregation is supported');
      }
    }
    earlier.add(step.id);
    return value;
  });
  keys(input.output, ['from', 'fields']); reference(input.output.from, earlier);
  if (input.output.fields !== undefined) fields(input.output.fields);
  return { version: 1, steps, output: structuredClone(input.output) };
}

export function batchField(value, selector) {
  if (value && typeof value === 'object' && Object.hasOwn(value, selector)) return value[selector];
  let current = value;
  for (const part of selector.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
function scalar(value) { return value === null || ['string', 'number', 'boolean'].includes(typeof value); }
function bounded(rows, observations) {
  if (rows.length > READ_BATCH_LIMITS.rows) { observations.omittedRows = (observations.omittedRows ?? 0) + rows.length - READ_BATCH_LIMITS.rows; observations.truncated = true; }
  return rows.slice(0, READ_BATCH_LIMITS.rows);
}
export function selectBatchFields(rows, selectors) {
  return rows.map(row => Object.fromEntries(selectors.map(selector => [selector, batchField(row, selector) ?? null])));
}
// Wildcard matching is a bounded table, not a user-supplied regular expression.
export function batchGlobMatches(pattern, value) {
  if (pattern.length > 160 || typeof value !== 'string' || value.length > 1000) return false;
  const target = pattern.includes('/') ? value : value.split('/').at(-1);
  let previous = new Uint8Array(target.length + 1); previous[0] = 1;
  for (let index = 0; index < pattern.length; index++) {
    const token = pattern[index], recursive = token === '*' && pattern[index + 1] === '*';
    if (recursive) index++;
    const recursiveDirectory = recursive && pattern[index + 1] === '/';
    if (recursiveDirectory) index++;
    const next = new Uint8Array(target.length + 1);
    if (token === '*') next[0] = previous[0];
    let prefix = previous[0];
    for (let cursor = 1; cursor <= target.length; cursor++) {
      const char = target[cursor - 1];
      prefix ||= previous[cursor - 1];
      next[cursor] = recursiveDirectory ? previous[cursor] || char === '/' && prefix
        : token === '*' ? previous[cursor] || ((recursive || char !== '/') && next[cursor - 1])
        : (token === '?' ? char !== '/' : token === char) && previous[cursor - 1];
    }
    previous = next;
  }
  return Boolean(previous[target.length]);
}

export function applyBatchTransform(step, source, observations = {}) {
  const rows = bounded(Array.isArray(source) ? source : [], observations);
  if (step.op === 'lines') {
    const output = [];
    for (const row of rows) {
      if (typeof row.content !== 'string' || row.binary === true) { observations.nonTextSources = (observations.nonTextSources ?? 0) + 1; continue; }
      const lines = row.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim()) continue;
        if (line.length > READ_BATCH_LIMITS.lineChars) { observations.oversizedLines = (observations.oversizedLines ?? 0) + 1; observations.truncated = true; continue; }
        if (output.length >= READ_BATCH_LIMITS.rows) { observations.truncated = true; observations.omittedRows = (observations.omittedRows ?? 0) + lines.length - index; break; }
        let value;
        if (step.format === 'text') value = { text: line };
        else {
          try { value = JSON.parse(line); } catch { observations.invalidJsonl = (observations.invalidJsonl ?? 0) + 1; continue; }
          if (!plain(value) || Object.keys(value).some(key => unsafe.has(key))) { observations.invalidJsonl = (observations.invalidJsonl ?? 0) + 1; continue; }
        }
        output.push({ ...value, _source: { path: row.path, evidenceId: row.sourceRef?.id ?? null, line: index + 1 } });
      }
    }
    return bounded(output, observations);
  }
  if (step.op === 'select') return selectBatchFields(rows, step.fields);
  if (step.op === 'filter') return rows.filter(row => {
    const value = batchField(row, step.where.field);
    return step.where.op === 'eq' ? scalar(value) && value === step.where.value
      : typeof value === 'string' && typeof step.where.value === 'string'
        && (step.where.op === 'contains' ? value.includes(step.where.value) : value.startsWith(step.where.value));
  });
  if (step.op === 'sort') return [...rows].sort((left, right) => {
    const a = batchField(left, step.field), b = batchField(right, step.field);
    const comparison = typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), 'en');
    return step.direction === 'desc' ? -comparison : comparison;
  });
  if (step.op === 'unique') {
    const seen = new Set();
    return rows.filter(row => { const value = batchField(row, step.field); if (!scalar(value)) return false;
      const key = JSON.stringify(value); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  if (step.op === 'aggregate') {
    if (!step.groupBy) return [{ count: rows.length }];
    const groups = new Map();
    for (const row of rows) {
      const value = batchField(row, step.groupBy) ?? null;
      if (!scalar(value)) { observations.nonScalarGroups = (observations.nonScalarGroups ?? 0) + 1; continue; }
      const key = JSON.stringify(value);
      const result = groups.get(key) ?? { [step.groupBy]: value, count: 0 };
      result.count++; groups.set(key, result);
    }
    return [...groups.values()];
  }
  fail('Unsupported pure transformation');
}
