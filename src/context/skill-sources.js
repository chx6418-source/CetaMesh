// Pure Settings value normalization; this is configuration, never read authority.
import path from 'node:path';

export const MAX_SKILL_SOURCES = 32;
const fail = () => { throw Object.assign(new Error('Skill sources require bounded unique IDs, absolute local directory roots, revisions and explicit enabled flags'), { code: 'SKILL_SOURCE_CONFIG_INVALID' }); };
export function normalizeSkillSources(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SKILL_SOURCES) fail();
  const ids = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['sourceId', 'root', 'revision', 'enabled'].includes(key))
      || typeof row.sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(row.sourceId)
      || typeof row.root !== 'string' || row.root.length > 2048 || /[\x00-\x1f\x7f*?]/.test(row.root)
      || !path.isAbsolute(row.root) || /^[\\/]{2}/.test(row.root)
      || row.root.split(/[\\/]/).some(part => part === '.' || part === '..')
      || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(row.root))
      || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 1) fail();
    const sourceId = row.sourceId, root = path.normalize(row.root);
    if (path.parse(root).root === root || ids.has(sourceId.toLowerCase())) fail();
    ids.add(sourceId.toLowerCase());
    return { sourceId, root, revision: row.revision, enabled: row.enabled };
  }).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
}
