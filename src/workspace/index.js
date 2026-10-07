// CetaMesh Workspace v1（阶段 05）—— 统一出口。
//
// createWorkspaceService({ stateDir }) 由 src/app/service-container.js 构造；
// workspace.* 经 src/app/ipc-runtime.js 路由。
export { createWorkspaceService } from './service.js';
export { WorkspaceBoundaryError, canonicalizeRoot, isInsideRoot, resolveInside } from './boundary.js';
export { WorkspaceRegistryError, workspaceRegistryFile, COMMIT_POLICIES } from './registry.js';
export { WorkspaceToolError } from './tools.js';
