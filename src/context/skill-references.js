/** Stable content references only. These never carry a permission or a root. */
export function normalizeSkillReferences(value) {
  if (value === undefined || value === null) return [];
  const fail = () => { throw Object.assign(new Error('Select at most 16 exact versioned Skill references'), { code: 'SKILL_REFERENCE_INVALID' }); };
  if (!Array.isArray(value) || value.length > 16) fail();
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['skillId', 'sourceRevision', 'sourceKind'].includes(key))
      || !/^skill:[a-f0-9]{40}$/.test(row.skillId ?? '') || !/^[a-f0-9]{64}$/.test(row.sourceRevision ?? '')
      || row.sourceKind !== undefined && !['project', 'user', 'installed'].includes(row.sourceKind)
      || seen.has(row.skillId)) fail();
    seen.add(row.skillId);
    return { skillId: row.skillId, sourceRevision: row.sourceRevision };
  });
}
