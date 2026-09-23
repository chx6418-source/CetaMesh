// 打包入口：esbuild 以本文件为 bundle 入口，输出单文件 CJS，再注入 Node SEA blob。
//
// 与 src/core-entry.js 的唯一区别是不做 isMainModule 判断——SEA 中 import.meta.url 与
// process.argv[1] 都等于 exe 自身路径，判断虽会成立，但入口不应依赖这一点：exe 被启动就
// 必须执行。这里无条件调用 runCore()。
import { runCore } from './core-dispatch.js';
import { reportEntrypointError } from './entrypoint.js';

runCore().catch((error) => reportEntrypointError('core', error));
