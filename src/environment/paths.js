import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {environmentError} from './contracts.js';

function deny() { throw environmentError('ENV_PATH_DENIED','Path is outside owned regular storage'); }
export function assertOwnedPath(root, relative, {mustExist=false,directory=false}={}) {
  if(typeof relative!=='string' || !relative || relative.includes(':') || /^[\\/]/.test(relative) || relative.split(/[\\/]/).some(p=>!p || p==='.' || p==='..' || /[. ]$/.test(p))) deny();
  const base=path.resolve(root), target=path.resolve(base,...relative.split(/[\\/]/));
  if(!target.startsWith(base+path.sep)) deny();
  let current=path.parse(base).root;
  for(const component of target.slice(current.length).split(path.sep)) {
    current=path.join(current,component);
    try { if(fs.lstatSync(current).isSymbolicLink()) deny(); } catch(e) { if(e.code!=='ENOENT') throw e; }
  }
  if(mustExist) { const s=fs.lstatSync(target); if(directory?!s.isDirectory():!s.isFile()) deny(); }
  return target;
}
export async function hashFile(file,{maxBytes=67108864}={}) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink()) deny();
  if(stat.size>maxBytes) throw environmentError('ENV_ARTIFACT_TOO_LARGE','Artifact exceeds byte limit');
  const h=crypto.createHash('sha256'); let bytes=0;
  for await(const chunk of fs.createReadStream(file)) { bytes+=chunk.length; if(bytes>maxBytes) throw environmentError('ENV_ARTIFACT_TOO_LARGE','Artifact grew beyond byte limit'); h.update(chunk); }
  return h.digest('hex');
}
export async function verifyFile(file,{sha256,bytes,maxBytes=67108864}={}) {
  const actual=await hashFile(file,{maxBytes}); const size=fs.statSync(file).size;
  if(actual!==sha256 || (bytes!==undefined && bytes!==size)) throw environmentError('ENV_HASH_MISMATCH','Artifact hash or size differs');
  return {sha256:actual,bytes:size};
}
