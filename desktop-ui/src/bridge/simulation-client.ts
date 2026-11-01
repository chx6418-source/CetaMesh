import { uiCall } from './typed-client';
export type SimulationMode = 'simulation' | 'project';
export interface PersonaExample { id: string; kind: 'positive' | 'negative' | 'multi-turn'; content: string; messages?: {role: 'user' | 'assistant'; content: string}[]; tags?: string[]; source?: string; revision?: number; sha256?: string; recommended?: boolean }
export interface PersonaRole { id: string; rev: number; name: string; avatar?: string; description?: string; sourceText: string; sha256?: string; examples: PersonaExample[]; behavior: {silenceAllowed: boolean; willingness: number; interests: string[]; cooldownMs: number; maxConsecutiveTurns: number}; model?: {provider?: string; model?: string} | null; memoryScopes: string[]; allowedTools: string[]; versions: {rev: number; sha256: string; createdAt: string | number}[] }
export interface SimulationPricing { providerId: string; model: string; currency: string; source: string; version: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number; cacheWritePerMillion: number }
export interface SimulationBudgetPolicy { maxTurns: number; maxOutputTokens: number; maxTotalTokens: number; maxDurationMs: number; maxModelCalls: number; maxCost: number | null; pricing: SimulationPricing | null }
export interface SimulationMessageDto { id: string; roleId: string | null; kind: 'user' | 'discussion' | 'notice' | 'project'; text: string; createdAt: string | number; stage?: string; trace?: {roleRevision?: number; sourceHash?: string; selectedExamples?: unknown[]} }
export interface SimulationTask { id?: string; taskId?: string; title?: string; goal?: string; status?: string; verification?: string | null; result?: {summary?: string} | null; outcome?: {status?: string; reasons?: string[]} | null; [key: string]: unknown }
export interface SimulationRoom { id: string; rev: number; title: string; scene: string; goal: string; status: 'idle' | 'running' | 'paused' | 'completed' | 'failed'; workspaceId?: string | null; roleIds: string[]; roleRefs?: {id: string; revision: number; name: string; sourceHash: string}[]; modelProvider?: string; model?: string; budget: SimulationBudgetPolicy; usage?: {modelCalls?: number; completedCalls?: number; inputTokens?: number; outputTokens?: number; accounting?: string; reservedCost?: number; cost?: {status: string; amount: number | null; knownAmount?: number | null; currency?: string}}; messages: SimulationMessageDto[]; historyTruncated?:boolean;messageCount?:number; tasks: SimulationTask[]; projectState?: string; activeRun?: {id: string; kind: string; turns: number; maxTurns: number; currentRoleId?: string | null} | null; lastError?: string | {code?: string; message?: string} | null }
export interface SimulationScene {id: string; name: string; description?: string}
export interface SimulationOverview {rooms: SimulationRoom[]; roles: PersonaRole[]; scenes: SimulationScene[]}
export const defaultSimulationBudget = (): SimulationBudgetPolicy => ({maxTurns:6,maxOutputTokens:768,maxTotalTokens:65536,maxDurationMs:120000,maxModelCalls:60,maxCost:null,pricing:null});
export const simulationClient = {
 overview: () => uiCall<SimulationOverview>('ui.simulation.overview', {}),
 rooms: () => uiCall<{rooms: SimulationRoom[]}>('ui.simulation.room.list', {}),
 room: (roomId: string) => uiCall<{room: SimulationRoom}>('ui.simulation.room.get', {roomId}),
 createRoom: (input: {title: string; scene: string; goal: string; roleIds: string[]; workspaceId?: string; modelProvider?: string; model?: string; budget?: SimulationBudgetPolicy}) => uiCall<{room: SimulationRoom}>('ui.simulation.room.create', input),
 updateRoom: (roomId: string, expectedRev: number, input: Partial<Pick<SimulationRoom,'title'|'goal'|'scene'|'roleIds'|'workspaceId'|'modelProvider'|'model'|'budget'>>) => uiCall<{room: SimulationRoom}>('ui.simulation.room.update',{roomId,expectedRev,...input}),
 send: (roomId: string, text: string, roleId: string | undefined, requestId: string) => uiCall<{room: SimulationRoom; message: SimulationMessageDto; runId?: string}>('ui.simulation.message.send',{roomId,text,roleId,requestId}),
 start: (roomId: string, roleId: string | undefined, maxTurns: number) => uiCall<{room: SimulationRoom; runId: string}>('ui.simulation.discussion.start',{roomId,roleId,maxTurns}),
 pause: (roomId: string) => uiCall<{room: SimulationRoom}>('ui.simulation.discussion.pause',{roomId}),
 cancel: (roomId: string) => uiCall<{room: SimulationRoom}>('ui.simulation.discussion.cancel',{roomId}),
 resume: (roomId: string,acknowledgeUnknown=false) => uiCall<{room: SimulationRoom}>('ui.simulation.discussion.resume',{roomId,...(acknowledgeUnknown?{acknowledgeUnknown:true}:{})}),
 end: (roomId: string) => uiCall<{room: SimulationRoom}>('ui.simulation.discussion.end',{roomId}),
 search: (roomId: string,query: string,offset=0,limit=50) => uiCall<{messages: SimulationMessageDto[];total:number;offset:number;nextOffset:number|null}>('ui.simulation.room.search',{roomId,query,offset,limit}),
 role: (id: string,revision?: number) => uiCall<{role: PersonaRole}>('ui.simulation.role.get',{id,revision}),
 saveRole: (input: Omit<PersonaRole,'rev'|'versions'|'id'|'examples'> & {id?: string; expectedRev?: number;examples?:PersonaExample[]}) => uiCall<{role: PersonaRole}>('ui.simulation.role.save',input),
 exportRole: (id: string,revision?: number) => uiCall<{bundle: unknown}>('ui.simulation.role.export',{id,revision}),
 importRole: (bundle: unknown) => uiCall<{role: PersonaRole}>('ui.simulation.role.import',{bundle,confirm:true}),
 restoreRole: (id: string,revision: number,expectedRev: number) => uiCall<{role: PersonaRole}>('ui.simulation.role.restore',{id,revision,expectedRev}),
 previewRole: (roleId: string,query: string,scene: string,revision?: number) => uiCall<{messages: {role:string;content:string}[]; selectedExamples: unknown[]; sourceHash?: string; sourceRevision?: number; [key:string]: unknown}>('ui.simulation.role.context',{roleId,query,scene,revision,maxChars:16000}),
 searchExamples: (roleId: string,query: string,revision?: number) => uiCall<{examples: PersonaExample[]}>('ui.simulation.role.searchExamples',{roleId,query,revision,maxResults:30}),
 legacy: () => uiCall<{assets: {id:string;name:string;kind:string;sha256:string;bytes:number;requiresOwnershipConfirmation:boolean}[]}>('ui.simulation.legacy.inventory',{}),
 importLegacy: (assetId: string,expectedSha256: string) => uiCall<{role: PersonaRole;backup:{id:string;sha256:string;bytes:number}}>('ui.simulation.legacy.import',{assetId,expectedSha256,confirm:true,ownershipConfirmed:true}),
 createProject: (roomId: string,goal: string,requirements: string[],acceptanceCriteria: string[],requestId: string) => uiCall<{room: SimulationRoom;task: SimulationTask}>('ui.simulation.project.create',{roomId,goal,requirements,acceptanceCriteria,requestId}),
 memory: (roomId:string,roleId?:string,query='') => uiCall<{memories:{id:string;content:string}[];candidates:{id:string;content:string;status?:string}[]}>('ui.simulation.memory.list',{roomId,roleId,query,limit:50}),
 proposeMemory: (roomId:string,content:string,roleId?:string) => uiCall<unknown>('ui.simulation.memory.propose',{roomId,content,roleId}),
 confirmMemory: (roomId:string,id:string,decision:'accept'|'reject',roleId?:string) => uiCall<unknown>('ui.simulation.memory.confirm',{roomId,id,decision,roleId}),
 startProject: (roomId:string,taskId:string,agentProvider:string,requestId:string,allowProjectTests=false) => uiCall<{room:SimulationRoom;task:SimulationTask;pending?:boolean;approvalId?:string;isolation?:string;stage?:string}>('ui.simulation.project.start',{roomId,taskId,agentProvider,requestId,allowProjectTests:allowProjectTests===true}),
 refreshProject: (roomId: string) => uiCall<{room: SimulationRoom;task?: SimulationTask;verification?:{status:string;reasons:string[]};stage?:string}>('ui.simulation.project.refresh',{roomId})
};
