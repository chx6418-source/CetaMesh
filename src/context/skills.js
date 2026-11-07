// A derived, authorization-scoped index. Settings/Workspace/Extension keep ownership.
import fs from 'node:fs';
import path from 'node:path';
import { extensionError } from '../extension/types.js';
import { SKILL_LIMITS, assertSkillResource, safeSkillPath, parseSkillDocument, skillHash, skillContentPage } from '../extension/skill-data.js';

const SOURCE_PRIORITY = Object.freeze({ project: 0, user: 1, installed: 2 });
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const positive = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
function boundedDirectory(directory, limit) {
  const result = [], handle = fs.opendirSync(directory);
  try {
    for (let entry; (entry = handle.readSync());) {
      result.push(entry);
      if (result.length > limit) throw extensionError('SKILL_SOURCE_LIMIT', 'Skill source has too many directory entries');
    }
  } finally { handle.closeSync(); }
  return result.sort((a, b) => order(a.name, b.name));
}
function reasonFor(error) {
  return ({ SKILL_FRONTMATTER_INVALID: 'invalid-frontmatter', SKILL_TOO_LARGE: 'file-too-large', SKILL_PATH_DENIED: 'path-or-link-denied',
    SKILL_SOURCE_LIMIT: 'source-limit', SKILL_RESOURCE_DENIED: 'resource-excluded', SKILL_SOURCE_STALE: 'source-stale',
    SKILL_PERMISSION_DENIED: 'permission-denied' })[error?.code] ?? 'source-unavailable';
}

export function createSkillContentService({ workspaceService = null, extensionRuntime = null,
  userSources = () => [], authorizeSource = null, limits = {} } = {}) {
  const budget = Object.fromEntries(Object.entries(SKILL_LIMITS).map(([key, value]) => [key, positive(limits[key], value, value)]));
  const omit = (rows, item) => { if (rows.length < 256) rows.push(item); };
  function checkPrincipal(request) {
    request.signal?.throwIfAborted();
    if (!request.principal || typeof request.principal !== 'object')
      throw extensionError('SKILL_AUTHORIZATION_REQUIRED', 'Skill references require a current trusted principal');
  }
  async function allowed(source, request, relativePath, operation) {
    request.signal?.throwIfAborted();
    if (typeof authorizeSource !== 'function') return source.sourceKind === 'installed';
    try {
      const decision = await authorizeSource({ principal: request.principal, taskId: request.taskId ?? null,
        workspaceId: source.workspaceId ?? request.workspaceId ?? null, sourceId: source.sourceId, sourceKind: source.sourceKind,
        root: source.root ?? null, relativePath, operation, sourceRevision: source.revision ?? source.sourceRevision ?? null });
      request.signal?.throwIfAborted();
      return decision === true || decision?.allowed === true;
    } catch (error) { request.signal?.throwIfAborted(); return false; }
  }
  async function requireAllowed(source, request, relativePath, operation) {
    if (!await allowed(source, request, relativePath, operation))
      throw extensionError('SKILL_PERMISSION_DENIED', 'Current source read authorization is required');
  }
  async function sourcesFor(request, omissions) {
    const sources = [];
    if (request.workspaceId) {
      const workspace = workspaceService?.describeWorkspace?.(request.workspaceId);
      if (workspace?.root && workspace.id === request.workspaceId) sources.push({ sourceKind: 'project',
        sourceId: 'workspace:' + workspace.id, workspaceId: workspace.id, root: workspace.root, relativeRoot: '.cetamesh/skills', revision: workspace.revision ?? 0 });
    }
    const configured = typeof userSources === 'function' ? await userSources() : [];
    if (Array.isArray(configured)) {
      const ids = new Set(), counts = new Map();
      for (const row of configured) if (row?.enabled === true) counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1);
      if (configured.length > 32) omit(omissions, { sourceKind: 'user', reason: 'source-limit' });
      for (const row of (configured.length > 32 ? [] : [...configured]).sort((a, b) => order(String(a?.sourceId), String(b?.sourceId)))) {
        if (!row || typeof row !== 'object') { omit(omissions, { sourceKind: 'user', reason: 'invalid-source-configuration' }); continue; }
        if (row.enabled !== true) continue;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(row.sourceId ?? '') || typeof row.root !== 'string' || !path.isAbsolute(row.root)) {
          omit(omissions, { sourceKind: 'user', reason: 'invalid-source-configuration' }); continue;
        }
        if (counts.get(row.sourceId) > 1) {
          if (!ids.has(row.sourceId)) omit(omissions, { sourceKind: 'user', sourceId: row.sourceId, reason: 'duplicate-source' });
          ids.add(row.sourceId); continue;
        }
        ids.add(row.sourceId);
        // authorizedBy is descriptive metadata, never a grant. allowed() must succeed before I/O.
        sources.push({ sourceKind: 'user', sourceId: row.sourceId, root: row.root, relativeRoot: '', revision: row.revision ?? 0 });
      }
    }
    const installed = extensionRuntime?.listSkillSources?.() ?? [];
    sources.push(...installed.map(row => ({ ...row, sourceKind: 'installed' })));
    return sources.sort((a, b) => SOURCE_PRIORITY[a.sourceKind] - SOURCE_PRIORITY[b.sourceKind] || order(a.sourceId, b.sourceId));
  }

  async function scanTree(source, request, skillRelative, omissions) {
    const files = new Map(); let bytes = 0;
    async function visit(relative = '') {
      const fullRelative = [skillRelative, relative].filter(Boolean).join('/');
      await requireAllowed(source, request, fullRelative, 'discover');
      const directory = safeSkillPath(source.root, fullRelative);
      for (const entry of boundedDirectory(directory, budget.sourceFiles)) {
        request.signal?.throwIfAborted();
        const child = relative ? relative + '/' + entry.name : entry.name;
        try { assertSkillResource(entry.isDirectory() ? child + '/reference.md' : child); }
        catch { omit(omissions, { sourceKind: source.sourceKind, sourceId: source.sourceId, reason: 'resource-excluded' }); continue; }
        const sourceRelative = skillRelative + '/' + child;
        await requireAllowed(source, request, sourceRelative, 'discover');
        const absolute = safeSkillPath(source.root, sourceRelative);
        const stat = fs.lstatSync(absolute);
        if (stat.isDirectory()) { await visit(child); continue; }
        if (!stat.isFile()) throw extensionError('SKILL_PATH_DENIED', 'Skill source contains a non-file resource');
        if (stat.size > budget.fileBytes) throw extensionError('SKILL_TOO_LARGE', 'Skill resource exceeds its byte limit');
        const content = fs.readFileSync(absolute);
        if (content.length > budget.fileBytes) throw extensionError('SKILL_TOO_LARGE', 'Skill resource changed beyond its byte limit');
        bytes += content.length;
        if (files.size >= budget.sourceFiles || bytes > budget.sourceBytes) throw extensionError('SKILL_SOURCE_LIMIT', 'Skill resources exceed their total budget');
        files.set(child, { sha256: skillHash(content), bytes: content });
      }
    }
    await visit();
    return files;
  }

  async function collect(request = {}) {
    checkPrincipal(request);
    const omissions = [], candidates = [];
    for (const source of await sourcesFor(request, omissions)) {
      request.signal?.throwIfAborted();
      if (!await allowed(source, request, source.relativeRoot ?? 'SKILL.md', 'list')) {
        omit(omissions, { sourceKind: source.sourceKind, sourceId: source.sourceId, reason: 'permission-denied' }); continue;
      }
      if (source.sourceKind === 'installed') {
        if (!source.description) { omit(omissions, { sourceId: source.sourceId, sourceKind: source.sourceKind, reason: 'missing-description' }); continue; }
        candidates.push({ source, relative: 'SKILL.md', metadata: { name: source.name, description: source.description, always: source.always },
          sha256: source.sha256, sourceRevision: source.sourceRevision });
        continue;
      }
      let directories;
      try {
        const directory = safeSkillPath(source.root, source.relativeRoot);
        directories = boundedDirectory(directory, 256);
      } catch (error) {
        if (error?.code !== 'ENOENT') omit(omissions, { sourceId: source.sourceId, sourceKind: source.sourceKind, reason: reasonFor(error) });
        continue;
      }
      for (const directory of directories) {
        request.signal?.throwIfAborted();
        if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
        const relative = [source.relativeRoot, directory.name].filter(Boolean).join('/');
        try {
          const files = await scanTree(source, request, relative, omissions), document = files.get('SKILL.md');
          if (!document) continue;
          const parsed = parseSkillDocument(document.bytes, { fallbackName: directory.name, maxBytes: budget.fileBytes });
          if (!parsed.metadata.description) {
            omit(omissions, { sourceId: source.sourceId, sourceKind: source.sourceKind, name: parsed.metadata.name, reason: 'missing-description' }); continue;
          }
          const tree = [...files].sort(([a], [b]) => order(a, b)).map(([name, row]) => [name, row.sha256]);
          candidates.push({ source, relative, metadata: parsed.metadata, sha256: parsed.sha256, files,
            sourceRevision: skillHash(JSON.stringify([source.sourceId, source.workspaceId ?? null, source.root, source.revision, tree])) });
        } catch (error) {
          request.signal?.throwIfAborted();
          omit(omissions, { sourceId: source.sourceId, sourceKind: source.sourceKind, reason: reasonFor(error) });
        }
      }
    }
    const entries = [], shadowed = [], records = new Map(), byName = new Map();
    candidates.sort((a, b) => SOURCE_PRIORITY[a.source.sourceKind] - SOURCE_PRIORITY[b.source.sourceKind]
      || order(a.source.sourceId, b.source.sourceId) || order(a.relative, b.relative));
    for (const candidate of candidates) {
      const { source, metadata } = candidate;
      const entry = { skillId: 'skill:' + skillHash(source.sourceId + '\0' + candidate.relative).slice(0, 40), ...metadata,
        sourceId: source.sourceId, sourceKind: source.sourceKind, sourcePriority: SOURCE_PRIORITY[source.sourceKind],
        sourceRevision: candidate.sourceRevision, sha256: candidate.sha256,
        ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
        ...(source.packageVersion ? { packageVersion: source.packageVersion, packageRevision: source.packageRevision } : {}),
        trust: 'untrusted-reference' };
      const key = metadata.name.toLowerCase();
      if (byName.has(key)) {
        if (shadowed.length < budget.entries) shadowed.push({ ...entry, shadowedBy: byName.get(key).skillId,
          reason: byName.get(key).sourceId === entry.sourceId ? 'case-or-name-collision' : 'source-priority' });
      } else if (entries.length >= budget.entries) omit(omissions, { sourceId: source.sourceId, sourceKind: source.sourceKind, name: metadata.name, reason: 'entry-limit' });
      else { byName.set(key, entry); entries.push(entry); records.set(entry.skillId, candidate); }
    }
    const result = { indexRevision: skillHash(JSON.stringify([entries, shadowed, omissions])), entries, shadowed, omissions };
    return { result, records };
  }

  async function readCollected(request, snapshot) {
    request.signal?.throwIfAborted();
    const entry = snapshot.result.entries.find(row => row.skillId === request.skillId);
    if (!entry) throw extensionError('SKILL_SOURCE_UNAVAILABLE', 'Skill source is no longer readable, enabled or registered; review its source');
    if (request.sourceRevision !== entry.sourceRevision) throw extensionError('SKILL_SOURCE_STALE', 'Skill content changed; select the reviewed current revision');
    const record = snapshot.records.get(entry.skillId), resource = assertSkillResource(request.resource ?? 'SKILL.md');
    await requireAllowed(record.source, request, record.source.sourceKind === 'installed' ? resource : record.relative + '/' + resource, 'read');
    if (record.source.sourceKind === 'installed') return extensionRuntime.readSkillContent({ extensionId: record.source.extensionId,
      sourceRevision: entry.sourceRevision, resource, offset: request.offset, maxBytes: request.maxBytes, signal: request.signal });
    const observed = record.files.get(resource);
    if (!observed) throw extensionError('SKILL_RESOURCE_DENIED', 'Resource is not part of this authorized Skill source');
    const bytes = fs.readFileSync(safeSkillPath(record.source.root, record.relative + '/' + resource));
    if (skillHash(bytes) !== observed.sha256) throw extensionError('SKILL_SOURCE_STALE', 'Skill resource changed during reading');
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) || bytes.includes(0)) throw extensionError('SKILL_CONTENT_INVALID', 'Skill resources must be UTF-8 text');
    request.signal?.throwIfAborted();
    return { ...skillContentPage(bytes, { offset: request.offset, maxBytes: Math.min(request.maxBytes ?? budget.pageBytes, budget.pageBytes) }),
      sha256: observed.sha256, sourceRevision: entry.sourceRevision, resource, trust: 'untrusted-reference' };
  }

  async function list(request = {}) { return (await collect(request)).result; }
  async function read(request = {}) {
    checkPrincipal(request); assertSkillResource(request.resource ?? 'SKILL.md');
    if (!/^skill:[a-f0-9]{40}$/.test(request.skillId ?? '') || !/^[a-f0-9]{64}$/.test(request.sourceRevision ?? ''))
      throw extensionError('SKILL_REFERENCE_INVALID', 'An exact Skill identity and source revision are required');
    return readCollected(request, await collect(request));
  }
  async function buildContext(request = {}) {
    const snapshot = await collect(request), { result } = snapshot;
    const maxChars = positive(request.maxChars, budget.totalChars, budget.totalChars);
    let indexText = '', text = '', truncated = false;
    const entries = [], always = [], selected = [], omissions = [...result.omissions];
    for (const entry of result.entries) {
      const line = JSON.stringify({ skillId: entry.skillId, sourceRevision: entry.sourceRevision, name: entry.name, description: entry.description, sourceKind: entry.sourceKind }) + '\n';
      if (indexText.length + line.length > Math.min(budget.indexChars, maxChars)) { truncated = true; continue; }
      indexText += line; entries.push(entry);
    }
    text = indexText;
    const refs = Array.isArray(request.selectedRefs) ? request.selectedRefs.slice(0, budget.entries) : [];
    const wanted = [...refs.map(ref => ({ ref, selected: true })), ...result.entries.filter(row => row.always).map(ref => ({ ref, selected: false }))];
    const included = new Set();
    for (const item of wanted) {
      if (included.has(item.ref.skillId)) continue;
      included.add(item.ref.skillId);
      try {
        const page = await readCollected({ ...request, skillId: item.ref.skillId, sourceRevision: item.ref.sourceRevision, maxBytes: budget.pageBytes }, snapshot);
        const header = '\n[untrusted Skill reference ' + item.ref.skillId + ']\n';
        const remaining = maxChars - text.length - header.length;
        if (remaining <= 0) { truncated = true; continue; }
        const content = page.content.slice(0, Math.min(item.selected ? budget.pageBytes : budget.alwaysChars, remaining));
        const row = { skillId: item.ref.skillId, sourceRevision: page.sourceRevision, content, truncated: page.truncated || content.length < page.content.length, trust: 'untrusted-reference' };
        (item.selected ? selected : always).push(row); text += header + content;
        truncated ||= row.truncated;
      } catch (error) {
        request.signal?.throwIfAborted();
        omit(omissions, { skillId: item.ref.skillId, reason: error?.code === 'SKILL_SOURCE_STALE' ? 'source-stale' : 'source-unavailable' });
      }
    }
    return { indexRevision: result.indexRevision, entries, indexText, always, selected, omissions, text,
      truncated: truncated || entries.length < result.entries.length, trust: 'untrusted-reference' };
  }
  return { list, read, buildContext };
}
