import path from 'node:path';
import {resolveInside,isInsideRoot} from '../workspace/boundary.js';
import {validateSchema} from '../model/input-schema.js';
import {reverseLabError} from './engine-assets.js';
import {REVERSELAB_ID,REVERSELAB_TOOL,ANALYSIS_INPUT} from './contracts.js';

export function registerReverseLabCapability({broker,workspaceService,taskRuntime,analyzer,extensionRuntime}){
  function admission(request){
    validateSchema(ANALYSIS_INPUT,request.input);
    const chain=request.scope?.pluginChain??[],leaf=chain.at(-1);
    if(request.constrainedActor?.kind!=='extension'||request.constrainedActor.id!==REVERSELAB_ID
      ||request.scope?.plugin!==REVERSELAB_ID||leaf?.id!==REVERSELAB_ID||!request.pluginParent
      ||request.pluginParent.capability!=='extension.'+REVERSELAB_ID+'.'+REVERSELAB_TOOL)
      throw reverseLabError('REVERSELAB_PLUGIN_AUTHORITY','Static analysis is internal to the installed reviewed ReverseLab plugin.');
    const installed=extensionRuntime.assertInvocation({id:REVERSELAB_ID,descriptorVersion:leaf.descriptorVersion});
    if(installed.manifest.scope.workspace!==request.workspaceId)throw reverseLabError('REVERSELAB_SCOPE_DENIED','Plugin Workspace differs from the authorized Task.');
    const workspace=workspaceService.describeWorkspace(request.workspaceId);
    if(!workspace)throw reverseLabError('WORKSPACE_NOT_FOUND','Workspace is unavailable.');
    const resolve=(relative,forWrite=false)=>{
      if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes(':')||relative.includes('\\')
        ||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw reverseLabError('REVERSELAB_SCOPE_DENIED','Use a relative reviewed Workspace path.');
      const candidate=resolveInside(workspace.root,relative,{forWrite}).real;
      const allowed=installed.manifest.scope.paths.some(scope=>{
        if(relative!==scope&&!relative.startsWith(scope+'/'))return false;
        const root=resolveInside(workspace.root,scope).real;return isInsideRoot(root,candidate);
      });
      if(!allowed)throw reverseLabError('REVERSELAB_SCOPE_DENIED','Path escapes the canonically reviewed plugin scope.');
      return candidate;
    };
    const target=resolve(request.input.path),artifactRoot=resolve(request.input.outputPath,true);
    if(isInsideRoot(target,artifactRoot)||isInsideRoot(artifactRoot,target))throw reverseLabError('REVERSELAB_SCOPE_DENIED','Analysis output must be separate from the analyzed application.');
    return {target,artifactRoot,workspace,resolve};
  }
  broker.register({id:'analysis.static',permission:'analysis.static',provider:'reverselab',risk:'high',effect:'non-idempotent',
    modelCallable:false,workspace:true,requiresTask:true,inputSchema:ANALYSIS_INPUT,
    description:'Internal reviewed ReverseLab static JavaScript analysis; writes original Evidence to a fresh Workspace run directory.',
    validate:admission,
    async execute(request){
      const selected=admission(request);
      const validateOutput=()=>{request.signal?.throwIfAborted();const now=admission(request);
        if(now.target!==selected.target||now.artifactRoot!==selected.artifactRoot)throw reverseLabError('REVERSELAB_SCOPE_CHANGED','Reviewed analysis path identity changed.');};
      const receipt=await analyzer.analyze({target:selected.target,artifactRoot:selected.artifactRoot,taskId:request.taskId,
        workspaceId:request.workspaceId,signal:request.signal,validateOutput});
      validateOutput();
      const task=taskRuntime.get({id:request.taskId}).task;
      const ref=path.relative(selected.workspace.root,receipt.indexPath).split(path.sep).join('/');
      taskRuntime.addArtifact({id:task.id,expectedRev:task.rev,kind:'file',label:'ReverseLab Evidence index',ref});
      return {...receipt,indexRef:ref,bundleRef:path.relative(selected.workspace.root,receipt.bundlePath).split(path.sep).join('/')};
    }});
}
