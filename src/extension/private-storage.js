import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

/** Extension-private key/value storage backed by the shared JSON Storage Primitive. */
export function createExtensionPrivateStorage({ file } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Extension private storage requires an absolute file path');
  const filePath = path.resolve(file);
  let cache = readJsonFile(filePath, { missing: null });
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};

  return {
    file: filePath,
    get(key) {
      const name = String(key);
      return Object.hasOwn(cache, name) ? cache[name] : null;
    },
    set(key, value) {
      cache[String(key)] = value === undefined ? null : value;
      writeJsonAtomic(filePath, cache);
      return true;
    },
    delete(key) {
      const name = String(key);
      const existed = Object.hasOwn(cache, name);
      if (existed) { delete cache[name]; writeJsonAtomic(filePath, cache); }
      return existed;
    },
    has(key) { return Object.hasOwn(cache, String(key)); },
    keys() { return Object.keys(cache); }
  };
}
