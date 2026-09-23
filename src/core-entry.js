#!/usr/bin/env node
// 源码模式统一入口：node src/core-entry.js <子命令>
//
// 分派逻辑在 src/core-dispatch.js，打包入口在 src/core-sea.js。保留本文件是为了让
// 源码运行、npm 脚本和既有测试继续使用同一路径。
import { isMainModule, reportEntrypointError } from './entrypoint.js';
import { runCore } from './core-dispatch.js';

export { CORE_USAGE, MCP_MODES, parseCoreArgs, runCore } from './core-dispatch.js';

if (isMainModule(import.meta.url)) {
  runCore().catch((error) => reportEntrypointError('core', error));
}
