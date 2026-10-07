// 运行面策略（Runtime Surface Policy）——运行模式的唯一判定点。
//
// 背景（D1）：release worker 曾无条件启动 loopback HTTP（consolePort，默认 3100），
// 「原生模式管理面走 IPC」只是把控制台令牌请求 403，HTTP listener 本身仍在。
// 这里把散落的判断（是否 packaged / 是否有 UI pipe / 是否 legacy opt-in）收拢成一个
// 纯函数，bridge.js 只根据返回值决定启动哪些服务面，不再自行读取零散 env。
//
// 三个服务面：
//   nativeControl  原生桌面管理面（named pipe，WHALEBRIDGE_UI_PIPE）——控制面唯一入口；
//   localDataIpc   MCP/agent 数据面（named pipe，按数据目录派生名）——始终启动；
//   legacyHttp     旧 Web 控制台 HTTP 面（127.0.0.1:consolePort）——仅源码开发显式开启。
//
// legacyHttp 的开启条件（两条同时满足，默认 OFF）：
//   1. env WHALEBRIDGE_LEGACY_HTTP=1（显式 opt-in，缺省/其它值一律关闭）；
//   2. 非发行构建（SEA 打包产物中该 env 被忽略并告警，发行版无法自动开启）。
import { isPackagedRuntime } from './app-paths.js';

export const RUNTIME_SURFACES = Object.freeze({
  nativeRelease: 'native-release',
  nativeDev: 'native-dev',
  headlessDev: 'headless-dev',
  legacyWebDev: 'legacy-web-dev'
});

export function resolveRuntimeSurfacePolicy({ env = process.env, packaged = isPackagedRuntime() } = {}) {
  const pipeName = String(env.WHALEBRIDGE_UI_PIPE ?? '').trim();
  const nativeControl = Boolean(pipeName);
  const legacyHttpRequested = String(env.WHALEBRIDGE_LEGACY_HTTP ?? '').trim() === '1';
  // 发行构建（SEA）里 legacy opt-in 一律忽略：发行版不携带旧 Web 面的运行许可。
  const legacyHttp = legacyHttpRequested && !packaged;
  const surface = packaged
    ? RUNTIME_SURFACES.nativeRelease
    : nativeControl
      ? RUNTIME_SURFACES.nativeDev
      : legacyHttp
        ? RUNTIME_SURFACES.legacyWebDev
        : RUNTIME_SURFACES.headlessDev;
  return Object.freeze({ surface, nativeControl, localDataIpc: true, legacyHttp, legacyHttpRequested });
}

/** 供启动日志/诊断使用的一句话描述。 */
export function describeRuntimeSurfacePolicy(policy) {
  const p = policy ?? resolveRuntimeSurfacePolicy();
  const faces = [
    p.nativeControl ? 'native-control:ipc' : 'native-control:off',
    'data-ipc:on',
    p.legacyHttp ? 'legacy-http:on(dev)' : 'legacy-http:off'
  ];
  return `${p.surface} (${faces.join(', ')})`;
}
