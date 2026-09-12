/* QQ 桥接控制台 · Mock 数据（贴合 config.example.json / 现有 console.html 功能） */
window.MOCK = {
  dsh: {
    url: 'http://127.0.0.1:3080',
    online: true, latency: 42,
    cookie: 'sk-bridge••••••••3f2a',
    workspace: 'QQ 聊天',
    callsToday: 342, successRate: '98.2%', p95: '2.1s'
  },
  models: [
    { id: 'deepseek-v3.2-exp', desc: '均衡 · 128K 上下文', tag: '当前', rec: true },
    { id: 'deepseek-r1', desc: '深度推理 · 慢但聪明', tag: '推理' },
    { id: 'glm-4.6', desc: '长文写作 · 中文强化', tag: '长文' },
    { id: 'qwen3-max', desc: '通用备选', tag: '' },
    { id: 'kimi-k2', desc: '联网问答备选', tag: '' }
  ],
  effort: 'medium',
  modes: [
    { id: 'chat', name: 'chat', desc: '白名单群 + 私聊安全聊天', preset: 'qq-chat', scene: '日常挂机' },
    { id: 'closed-agent', name: 'closed-agent', desc: '仅 Owner 私聊，完整工具可操控 DSH', preset: 'router-standard', scene: '远程运维' },
    { id: 'reserved', name: 'reserved', desc: '一代仿真群友 · 状态机主动参聊', preset: 'qq-chat', scene: '仿真一代' },
    { id: 'reserved2', name: 'reserved2', desc: '二代仿真 · AI 自主收发 / 唤醒 / 潜水', preset: 'qq-chat-v2', scene: '仿真二代' }
  ],
  currentMode: 'chat',
  presets: [
    { id: 'qq-chat', name: 'qq-chat', desc: 'QQ 安全聊天人格，仅附加 QQ 场景规则', model: 'deepseek-v3.2-exp', tools: 6,
      prompt: '你是 QQ 群聊 / 私聊中的 AI 桥接代理。规则：\n1. 只使用安全子集工具（收发消息 / 查历史 / 表情包）。\n2. 语气自然，像真人群友，短句为主，可用空格分条。\n3. 涉及敏感内容一律拒绝并提醒 Owner。\n4. 引用消息注意判断说话对象，不要误接话。' },
    { id: 'qq-chat-v2', name: 'qq-chat-v2', desc: '二代仿真 · AI 自主看消息、发言、等待、设置唤醒', model: 'deepseek-v3.2-exp', tools: 9,
      prompt: '你是二代仿真群友。通过 qq_get_unread_messages 主动看消息，用 qq_send_message 发言；\n可以使用 set_wake_config 设置沉睡/唤醒，潜水时无需逐条回复。\n保持人设一致，控制发言频率（maxSendPerMinute）。' },
    { id: 'router-standard', name: 'router-standard', desc: 'closed-agent 完整工具，可在 QQ 上操控 DSH', model: 'deepseek-r1', tools: 14,
      prompt: '你是 Owner 的远程运维代理，运行在 closed-agent 模式。\n拥有完整 DSH 工具与 snowluma-host 进程控制（需显式开启）。\n执行前简要确认影响面，执行后回报结果。' }
  ],
  roles: [
    { name: '默认（关闭角色扮演）', content: '' },
    { name: '赛博侦探', content: 'El Psy Kongroo。说话冷静克制，喜欢用「机关」称呼神秘事物，偶尔中二。' },
    { name: '傲娇猫娘', content: '哼、才、才不是特别想你呢喵！句子结尾偶尔带「喵」，嘴硬心软。' },
    { name: '毒舌军师', content: '言简意赅，一针见血，擅长吐槽但关键时刻给真建议。' },
    { name: '老学究', content: '引经据典，爱用「昔日」「盖因」，偶尔科普冷知识。' }
  ],
  currentRole: '赛博侦探',
  slang: [
    { term: 'yyds', meaning: '永远的神' },
    { term: 'xswl', meaning: '笑死我了' },
    { term: '蚌埠住了', meaning: '绷不住了' },
    { term: '尊嘟假嘟', meaning: '真的假的' },
    { term: '6', meaning: '溜 / 厉害' },
    { term: '破防了', meaning: '心理防线被击穿' },
    { term: '自习室', meaning: '摸鱼时假装学习' }
  ],
  sessions: [
    { key: 'group:952719003', name: 'AI 仿真群', type: '群聊', state: 'busy', stateText: '回合中…', unread: 0, color: '#6366f1' },
    { key: 'private:10001', name: 'Owner', type: '私聊', state: 'ok', stateText: '空闲', unread: 0, color: '#10b981' },
    { key: 'group:31415926', name: '测试群', type: '群聊', state: 'sleep', stateText: '沉睡至 08:30', unread: 3, color: '#f59e0b' },
    { key: 'private:20002', name: '小雪', type: '私聊', state: 'wait', stateText: '待回答', unread: 1, color: '#ec4899' }
  ],
  pending: [
    { id: 'p1', kind: 'tool', title: '工具审批 · web_search', detail: '「明天上海天气怎么样」→ 联网查询', timeout: '27s 后自动拒绝' },
    { id: 'p2', kind: 'ask', title: 'AI 提问 · ask_user_question', detail: '要把凌晨 4 点的自动重启打开吗？', timeout: '' }
  ],
  tools: [
    { name: 'qq_send_message', args: '群 952719003 · "El Psy Kongroo~"', dur: '0.8s', ok: true },
    { name: 'web_search', args: 'DSH 0.1.5 Web API 变更', dur: '2.4s', ok: true },
    { name: 'qq_get_unread_messages', args: 'group:31415926', dur: '0.2s', ok: true },
    { name: 'set_wake_config', args: 'sleepUntil 08:30', dur: '0.3s', ok: true },
    { name: 'kugou_parse', args: '「晴天」VIP 无损', dur: '6.1s', ok: false }
  ],
  memories: [
    { key: 'group:952719003', name: 'AI 仿真群', text: '群主爱聊技术；周五晚有固定云聚会；阿雪在做毕设', n: 12 },
    { key: 'group:31415926', name: '测试群', text: '主要用于联调，少踩雷话题：前任、加班', n: 5 },
    { key: 'private:10001', name: 'Owner', text: '喜欢简洁汇报；讨厌被重复问已确认的事', n: 8 }
  ],
  whitelist: {
    private: [{ v: '10001', note: 'Owner' }, { v: '20002', note: '小雪' }],
    groups: [{ v: '952719003', note: 'AI 仿真群' }, { v: '31415926', note: '测试群' }],
    deny: []
  },
  settings: { silent: false, intercept: true, notifyOwner: true, bilibili: true, fileSend: true, search: true, sendDelayMs: 800, volumeGain: 1.0, ackMessage: '', splitSend: true },
  kugou: { loggedIn: true, user: '芝士雪豹' },
  token: 'qkb-9f3e••••••••d21c',
  consoleUrl: 'http://127.0.0.1:3100'
};

/* 模拟日志池 */
window.LOG_POOL = [
  { dir: 'in',  msg: '<span class="who">群 · AI仿真群</span> 谁懂啊，这桥接也太好玩了吧' },
  { dir: 'out', msg: '→ 群 · AI仿真群：El Psy Kongroo~（0.9s）' },
  { dir: 'in',  msg: '<span class="who">私聊 · Owner</span> /model deepseek-r1' },
  { dir: 'sys', msg: '模式切换：chat → closed-agent，预设 router-standard 已加载' },
  { dir: 'out', msg: '→ 私聊 · Owner：已切换模型 deepseek-r1，推理强度=高' },
  { dir: 'in',  msg: '<span class="who">群 · 测试群</span> [引用 芝士雪豹：今晚八点集合] 收到喵' },
  { dir: 'sys', msg: 'DSH 会话已创建（workspace: QQ 聊天 · 4 个活跃会话）' },
  { dir: 'err', msg: 'SnowLuma WS 断线，3s 后重连（第 2 次）' },
  { dir: 'out', msg: '→ 群 · 测试群：八点见，我带资料（分句 ×2）' },
  { dir: 'in',  msg: '<span class="who">群 · AI仿真群</span> 尊嘟假嘟？AI 真的会自己潜水？' },
  { dir: 'sys', msg: '安全拦截：出站消息命中敏感规则，已通知 Owner' },
  { dir: 'out', msg: '→ 私聊 · Owner：⚠️ 拦截提醒：测试群出站消息被过滤' },
  { dir: 'in',  msg: '<span class="who">私聊 · 小雪</span> 在吗，帮我查个东西' },
  { dir: 'sys', msg: '工具审批已转发 QQ：web_search（等待 Owner 回复）' },
  { dir: 'out', msg: '→ 群 · AI仿真群：真的假的，自己试试就知道了 [表情:滑稽]' },
  { dir: 'sys', msg: '酷狗 Cookie 已刷新（VIP 有效期 23 天）' },
  { dir: 'in',  msg: '<span class="who">群 · AI仿真群</span> 6' },
  { dir: 'out', msg: '→ 群 · AI仿真群：[[SILENT]] 潜水，不接话' }
];
