// CetaMesh Desktop Node —— Channel Adapter 定位（阶段 11）。
//
// 阶段要求：QQ 已有能力不删，但必须**明确放回 Channel Adapter**，
// 而且不能让 QQ 生命周期决定 Desktop Core 生命周期。
//
// 本文件把这个定位变成**机器可读的声明 + 可断言的不变量**：
//   - Channel Adapter 是外部通道的接入层，不是 Core 的入口，也不是 Core 的依赖；
//   - adapter 的 state 只描述"这条通道能不能用"，绝不参与 Core readiness 判定。
//
// 注：SnowLuma/QQ 的连接生命周期位于 src/channel/qq/runtime.js；bridge.js 保留 Legacy QQ/Social 策略。
// 连接失败只降级 QQ 链路，Core 继续运行。这里声明的是通道与 Core 的独立关系。

export const CHANNEL_ADAPTERS = Object.freeze([
  {
    id: 'qq',
    name: 'QQ（OneBot v11 / SnowLuma）',
    kind: 'channel-adapter',
    implementation: 'src/channel/qq/runtime.js + src/bridge.js + src/mcp-snowluma-safe.js',
    provides: ['qq.message.receive', 'qq.message.send', 'qq.card.read', 'qq.file.send'],
    coreDependency: false,
    notes: '外部通道接入层；不可用时只降级 QQ 链路，Desktop Core 继续运行。'
  }
]);

export const CHANNEL_STATES = Object.freeze(['unknown', 'connecting', 'connected', 'unavailable', 'error']);

export function createChannelRegistry({ now = () => Date.now() } = {}) {
  const states = new Map();
  for (const adapter of CHANNEL_ADAPTERS) {
    states.set(adapter.id, { id: adapter.id, state: 'unknown', lastError: null, lastChangeAt: now() });
  }

  return {
    list() {
      return CHANNEL_ADAPTERS.map((adapter) => {
        const runtime = states.get(adapter.id);
        return {
          id: adapter.id,
          name: adapter.name,
          kind: adapter.kind,
          provides: [...adapter.provides],
          coreDependency: adapter.coreDependency === true,
          implementation: adapter.implementation,
          notes: adapter.notes,
          state: runtime.state,
          status: runtime.state === 'connected' ? 'online' : runtime.state === 'error' ? 'error' : 'offline',
          lastError: runtime.lastError,
          lastChangeAt: runtime.lastChangeAt
        };
      });
    },

    setState(id, state, error = null) {
      const runtime = states.get(String(id));
      if (!runtime) throw new Error('未知 Channel Adapter：' + String(id));
      if (!CHANNEL_STATES.includes(state)) throw new Error('未知通道状态：' + String(state));
      runtime.state = state;
      runtime.lastError = error === null || error === undefined ? null : String(error).slice(0, 400);
      runtime.lastChangeAt = now();
      return { adapter: { ...runtime } };
    },

    /**
     * 不变量：没有任何 Channel Adapter 参与 Core readiness。
     * 返回结构供 UI 与测试直接断言，而不是靠注释承诺。
     */
    independence() {
      const gating = CHANNEL_ADAPTERS.filter((adapter) => adapter.coreDependency === true).map((adapter) => adapter.id);
      return {
        invariant: 'channel-lifecycle-must-not-gate-core',
        coreGatedByChannels: gating.length > 0,
        gatingChannels: gating,
        channels: CHANNEL_ADAPTERS.map((adapter) => adapter.id)
      };
    }
  };
}
