// CetaMesh Workspace v1（阶段 05）—— 统一出口。
//
// 用法（bridge.js）：createWorkspaceService({ stateDir }) 产出的 service 挂到
// startUiIpcServer 的 dispatch 链，方法族 workspace.*。
export { createWorkspaceService } from './service.js';
export { WorkspaceBoundaryError, canonicalizeRoot, isInsideRoot, resolveInside } from './boundary.js';
export { WorkspaceRegistryError, workspaceRegistryFile, COMMIT_POLICIES } from './registry.js';
export { WorkspaceToolError } from './tools.js';
