// Simulation plans are content. Existing Tasks, Broker approvals and Workspace own execution.
import crypto from 'node:crypto';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const text=(value,max=2000)=>typeof value==='string'?value.trim().slice(0,max):'';
const items=value=>Array.isArray(value)?value.slice(0,50).map(x=>text(typeof x==='string'?x:x?.text,1000)).filter(Boolean):[];
const projection=t=>({id:t.id,rev:t.rev,goal:t.goal,title:t.goal,status:t.status,workspaceId:t.workspaceId,
  currentPhase:t.currentPhase,progress:t.progress,verification:t.result?.verification??'NEEDS_REVIEW',
  attemptCount:t.attempts?.length??0,artifacts:(t.artifacts??[]).slice(-30).map(x=>({id:x.id,kind:x.kind,label:x.label,ref:x.ref}))});
const linkedIds=room=>(room.tasks??[]).map(x=>typeof x==='string'?x:x.taskId??x.id);

export function createSimulationProjectBridge({taskService,workspaceService,capabilityService,taskUi}={}) {
  const runtime=taskService.runtime,preparing=new Map();
  function workspace(room) {
    const id=room?.workspaceId;
    if(!id||!workspaceService.describeWorkspace(id))fail('SIMULATION_WORKSPACE_REQUIRED','请先选择已授权 Workspace，再创建真实项目任务。');
    return workspaceService.describeWorkspace(id);
  }
  function taskFor(room,taskId) {
    const id=taskId||linkedIds(room).at(-1);
    if(!id||!linkedIds(room).includes(id))fail('SIMULATION_TASK_SCOPE_DENIED','此任务未关联当前仿真房间。');
    return runtime.get({id}).task;
  }
  async function requireTaskWorkspace(room,task) {
    const source=workspace(room);
    if(task.workspaceId===source.id)return;
    const overview=await workspaceService.execute({method:'workspace.git.overview',params:{id:source.id}});
    if(!overview.worktrees?.some(w=>w.taskId===task.id&&w.workspaceId===task.workspaceId))
      fail('SIMULATION_TASK_SCOPE_DENIED','任务的 Workspace 与房间或受控 Worktree 不匹配。');
  }
  async function isolatedTask(room,task) {
    const source=workspace(room);
    await requireTaskWorkspace(room,task);
    if(task.workspaceId!==source.id)return {task};
    const overview=await workspaceService.execute({method:'workspace.git.overview',params:{id:source.id}});
    if(!overview.git?.isRepo)return {task,isolation:'workspace-bound'};
    if(overview.git.dirty)fail('SIMULATION_WORKSPACE_DIRTY','源仓库有未提交修改，请先审阅并提交，避免隔离开发遗漏这些修改。');
    const branch='codex/simulation-'+crypto.createHash('sha256').update(task.id).digest('hex').slice(0,16);
    let worktree=overview.worktrees?.find(w=>w.taskId===task.id&&w.branch===branch&&w.workspaceId);
    if(!worktree) {
      const result=await capabilityService.broker.execute({actor:{kind:'owner',id:'desktop'},
        requestId:'simulation-worktree:'+task.id,operationId:'simulation-worktree:'+task.id,
        taskId:task.id,workspaceId:source.id,capability:'git.worktree.create',
        input:{branch,expectedHead:overview.git.headSha},reason:'在当前任务范围内建立隔离开发 Worktree；保留源仓库。'});
      if(result.status!=='completed')return {task,pending:true,approvalId:result.approvalId,isolation:'awaiting-approval'};
      const current=await workspaceService.execute({method:'workspace.git.overview',params:{id:source.id}});
      worktree=current.worktrees?.find(w=>w.taskId===task.id&&w.branch===branch&&w.workspaceId);
      if(!worktree)fail('SIMULATION_WORKTREE_RECONCILIATION_REQUIRED','Worktree 操作已有回执但关联未确认，请核对真实状态，不要重复创建。');
    }
    const latest=runtime.get({id:task.id}).task;
    if(latest.status!=='queued'||latest.workspaceId!==source.id)fail('SIMULATION_TASK_CHANGED','任务状态已变化，请核对后继续。');
    const updated=runtime.update({id:latest.id,expectedRev:latest.rev,workspaceId:worktree.workspaceId});
    return {task:updated,isolation:'git-worktree'};
  }
  return {
    async create({room,goal,requirements,acceptanceCriteria,requestId}={}) {
      const source=workspace(room),intent=text(requestId,128);
      if(!intent)fail('SIMULATION_REQUEST_ID_REQUIRED','项目创建需要稳定请求标识。');
      const taskRequestId='simulation:'+crypto.createHash('sha256').update(JSON.stringify([room.id,intent])).digest('hex');
      const plan={goal:text(goal)||text(room.goal),workspaceId:source.id,requirements:items(requirements),acceptanceCriteria:items(acceptanceCriteria)};
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
      const created=runtime.create({...plan,
        requestId:taskRequestId,launchFingerprint:fingerprint,requestedAgentProvider:'cetamesh',
        currentPhase:'仿真方案已保存，等待真实执行授权',note:'Simulation discussion is a proposal; actual completion requires Task evidence.'});
      if(created.createRequest?.id!==taskRequestId||created.createRequest?.launchFingerprint!==fingerprint)
        fail('SIMULATION_TASK_PLAN_CONFLICT','已有同目标任务使用不同来源或验收计划，请从 Tasks 审阅，不会自动接管。');
      return {task:projection(created),stage:'waiting-authorization'};
    },
    async start({room,taskId,agentProvider='cetamesh',modelProvider,model,allowProjectTests,requestId}={}) {
      if(allowProjectTests!==undefined&&typeof allowProjectTests!=='boolean')fail('SIMULATION_INPUT_INVALID','项目测试授权必须由用户明确选择。');
      const current=taskFor(room,taskId);
      await requireTaskWorkspace(room,current);
      if(current.status!=='queued')fail('SIMULATION_TASK_RECOVERY_REQUIRED','任务已派发或中断，请从 Tasks 核对、取消或恢复，不能重新执行整项任务。');
      const dispatch={agentProvider:text(agentProvider,80)||'cetamesh',
        modelProvider:text(modelProvider??room.modelProvider,80)||undefined,model:text(model??room.model,160)||undefined,
        allowProjectTests:allowProjectTests??null};
      const fingerprint=JSON.stringify(dispatch),pending=preparing.get(current.id);
      if(pending){
        if(pending.fingerprint!==fingerprint)fail('SIMULATION_START_CONFLICT','已有不同执行者、模型或测试授权的启动请求，请核对原请求完成状态后继续。');
        return pending.promise;
      }
      const work=(async()=>{
        const prepared=await isolatedTask(room,current);
        if(prepared.pending)return {...prepared,task:projection(prepared.task),stage:'waiting-authorization'};
        if(allowProjectTests!==undefined){
          let prior;try{prior=capabilityService.principalForTask(prepared.task.id);}catch{prior=capabilityService.grantTask(prepared.task.id);}
          const requested=new Set(prior.grants.capabilities);
          if(allowProjectTests)requested.add('test.run');else requested.delete('test.run');
          // Requestable capability only, scoped to this Task's current Workspace. Every
          // test invocation still requires its exact normal Broker/Owner approval.
          capabilityService.grantTask(prepared.task.id,{capabilities:[...requested]});
        }
        const result=await taskUi('ui.task.start',{id:prepared.task.id,expectedRev:prepared.task.rev,
          agentProvider:dispatch.agentProvider,requestId:text(requestId,128)||'simulation-start:'+current.id,
          modelProvider:dispatch.modelProvider,model:dispatch.model});
        return {...result,stage:'execution',isolation:prepared.isolation};
      })().finally(()=>preparing.delete(current.id));
      preparing.set(current.id,{fingerprint,promise:work});return work;
    },
    async refresh({room,taskId,kind='code'}={}) {
      const task=taskFor(room,taskId);await requireTaskWorkspace(room,task);
      const verification=await runtime.verifyOutcome({id:task.id,kind:['code','tool','analysis'].includes(kind)?kind:'code'});
      const latest=runtime.get({id:task.id}).task;
      if(latest.rev!==task.rev||latest.workspaceId!==task.workspaceId)fail('SIMULATION_TASK_CHANGED','任务在验收期间发生变化，请重新核对当前结果。');
      const stage=task.status==='completed'&&verification.status==='VERIFIED'?'delivered':
        ['running','waiting'].includes(task.status)?'execution':task.status==='queued'?'waiting-authorization':'verification';
      return {task:projection(task),verification,stage};
    }
  };
}
