import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJsonFile,writeJsonAtomic} from '../../src/storage/json-file.js';
import {assertManifest} from '../../src/extension/manifest.js';
import {resolveInside} from '../../src/workspace/boundary.js';

const template=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../extensions/cetamesh-reverselab');
// Installation preparation is a production path; tests use the same binding and parser.
export function prepareReverseLabPlugin({workspaceService,workspaceId,paths,outputRoot}){
  const workspace=workspaceService.describeWorkspace(workspaceId);
  if(!workspace)throw Object.assign(new Error('Choose an existing available CetaMesh Workspace.'),{code:'WORKSPACE_NOT_FOUND'});
  if(!Array.isArray(paths)||!paths.length)throw Error('Declare the input and output scope directories.');
  const raw=readJsonFile(path.join(template,'extension.json'));
  raw.scope={workspace:workspace.id,paths};const manifest=assertManifest(raw);
  for(const relative of manifest.scope.paths){const resolved=resolveInside(workspace.root,relative).real;
    if(!fs.statSync(resolved).isDirectory())throw Error('P1 scope paths must be existing directories.');}
  if(fs.existsSync(outputRoot))throw Object.assign(new Error('Choose a fresh plugin preparation directory.'),{code:'REVERSELAB_OUTPUT_EXISTS'});
  fs.cpSync(template,outputRoot,{recursive:true,errorOnExist:true,force:false});
  writeJsonAtomic(path.join(outputRoot,'extension.json'),raw);
  return {sourceDir:outputRoot,manifest,workspaceId:workspace.id};
}
