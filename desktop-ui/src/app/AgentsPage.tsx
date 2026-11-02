import { useCallback, useEffect, useRef, useState } from 'react';
import { agentClient, taskClient, type Agent, type Task } from '../bridge/typed-client';
import { Icon } from '../components/icons';
import { Button, SearchInput, Tabs } from '../components/primitives/inputs';
import { Badge, Banner, Card, LoadingState, Surface } from '../components/primitives/surfaces';
import { ErrorNotice, Heading, EmptyNotice, StatusBadge, availabilityReasonLabel, dshSetupReasonLabel, messageOf } from './PagePresentation';
import { mergeAgentHealth, AgentSetupDiagnostic, DshSetupPanel, agentNeedsSetup, AgentRuntimeAuthenticationNotice, AgentConnectionSteps, AgentRuntimeSetupDisclosure, isRuntimeProvider, isAgentReady, CodexSetupDiagnostic, AgentInstallationDiagnostic } from './AgentSetupPanels';

const agentInitials = (id: string) => id.slice(0, 2).toUpperCase();
const unverifiedAfterCheck = (agent: Agent): Agent => ({ ...agent, available: null, reachable: null, ready: null, eligible: null, taskEligible: null, status: 'not-checked', reason: 'CHECK_FAILED', connection: null });

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const sequence = useRef(0);
  const latestRefresh = useRef(0);
  const latestAgentRequest = useRef<Record<string, number>>({});
  const lifetime = useRef(0);
  const refresh = useCallback(async (forceRefresh = false) => {
    const request = ++sequence.current, epoch = lifetime.current;
    latestRefresh.current = request;
    setLoading(true);
    let agentListFailed = false;
    try {
      const [agentResult, taskResult] = await Promise.all([agentClient.list(forceRefresh).catch(cause => { agentListFailed = true; throw cause; }), taskClient.overview('', '')]);
      if (epoch !== lifetime.current || request !== latestRefresh.current) return;
      setAgents(current => {
        const previous = new Map(current.map(agent => [agent.id, agent]));
        return agentResult.agents.map(agent => (latestAgentRequest.current[agent.id] ?? 0) > request ? previous.get(agent.id) ?? agent : agent);
      });
      setTasks(taskResult.tasks); setError('');
    }
    catch (cause) {
      if (epoch === lifetime.current && request === latestRefresh.current) {
        if (agentListFailed) setAgents(current => current.map(agent => (latestAgentRequest.current[agent.id] ?? 0) > request ? agent : unverifiedAfterCheck(agent)));
        setError(messageOf(cause));
      }
    }
    finally { if (epoch === lifetime.current && request === latestRefresh.current) setLoading(false); }
  }, []);
  useEffect(() => { ++lifetime.current; void refresh(); return () => { ++lifetime.current; }; }, [refresh]);
  const ready = agents.filter(isAgentReady).length;
  const taskReady = agents.filter(agent => agent.taskEligible === true && isAgentReady(agent)).length;
  const needsSetup = agents.filter(agentNeedsSetup).length;
  const activeTasks = tasks.filter(task => ['working', 'running'].includes(task.status)).length;
  const visible = agents.filter(agent => (filter === 'all' || (filter === 'ready' ? isAgentReady(agent) : agentNeedsSetup(agent))) && `${agent.name} ${agent.role} ${agent.description}`.toLowerCase().includes(query.toLowerCase()));
  async function check(agent: Agent) {
    const request = ++sequence.current, epoch = lifetime.current;
    latestAgentRequest.current[agent.id] = request;
    setChecking(current => ({ ...current, [agent.id]: true }));
    try {
      const health = await agentClient.health(agent.id, true);
      if (epoch !== lifetime.current || latestAgentRequest.current[agent.id] !== request || latestRefresh.current > request) return;
      setAgents(current => current.map(item => item.id === agent.id ? mergeAgentHealth(item, health) : item));
      setError('');
    }
    catch (cause) {
      if (epoch === lifetime.current && latestAgentRequest.current[agent.id] === request && latestRefresh.current <= request) {
        setAgents(current => current.map(item => item.id === agent.id ? unverifiedAfterCheck(item) : item));
        setError(messageOf(cause));
      }
    }
    finally { if (epoch === lifetime.current && latestAgentRequest.current[agent.id] === request) setChecking(current => ({ ...current, [agent.id]: false })); }
  }
  function configured(id: string, patch: Partial<Agent>) {
    latestAgentRequest.current[id] = ++sequence.current;
    setChecking(current => ({ ...current, [id]: false }));
    setAgents(current => current.map(item => item.id === id ? { ...item, ...patch, available: null, reachable: null, ready: null, eligible: null, taskEligible: null, status: 'not-checked', reason: 'runtime_not_checked', connection: null } : item));
  }
  return <div className="content-page"><Heading eyebrow="AGENT DIRECTORY" title="Agents" description="查看可用 Agent、连接状态与职责。" action={<Button icon="update" onClick={() => void refresh(true)}>刷新状态</Button>} /><Banner><span className="grow"><strong>Gemini · OpenCode · Qwen · Claude 原生权限模式</strong><small>此模式没有 OS 沙箱；批准的命令可能访问宿主文件与网络。每个工作区仍需 Owner 确认，并逐次审批原生工具。</small></span></Banner>{error && <ErrorNotice error={error} onRetry={() => void refresh(true)} />}
    <div className="agent-summary-row"><Surface><strong>{agents.length}</strong><span>已登记 Agent</span></Surface><Surface><strong>{ready}</strong><span>可用 Agent</span></Surface><Surface><strong>{taskReady}</strong><span>任务可用</span></Surface><Surface><strong>{needsSetup}</strong><span>需要设置</span></Surface><Surface><strong>{activeTasks}</strong><span>活跃任务</span></Surface></div>
    <div className="row between work-controls"><Tabs items={[{ id: 'all', label: `全部 Agent ${agents.length}` }, { id: 'ready', label: `可用 Agent ${ready}` }, { id: 'setup', label: `需设置 ${needsSetup}` }]} selected={filter} onChange={setFilter} label="Agent 状态筛选" /><SearchInput label="搜索 Agent" placeholder="搜索名称或职责" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {loading && !agents.length ? <LoadingState label="正在读取 Agent 状态…" /> : visible.length ? <div className="agent-grid">{visible.map(agent => <Card className="agent-card" key={agent.id}><div className="row between"><div className="agent-avatar">{agentInitials(agent.id)}</div><StatusBadge value={agent.status === 'ready' && !isAgentReady(agent) ? 'not-checked' : agent.status} available={isAgentReady(agent)} /></div><h3>{agent.name}</h3><strong className="agent-role">{agent.role}</strong><p>{agent.description}</p>{!isAgentReady(agent) && agent.reason && <small className="agent-unavailable-reason" role="status">{agent.reason === 'task-required' ? '请先检查连接与任务执行条件。' : agent.id === 'dsh' ? dshSetupReasonLabel(agent.reason) : availabilityReasonLabel(agent.reason)}</small>}<details className="agent-capability-details"><summary>连接与运行能力</summary>{agent.id === 'dsh' && <AgentSetupDiagnostic agent={agent} />}{agent.id === 'codex' && <CodexSetupDiagnostic agent={agent} />}{agent.reason === 'task-required' && <small>{isAgentReady(agent) ? '此能力需要先分配工作区任务。' : '请先检查连接与任务执行条件。'}</small>}{agent.id !== 'dsh' && agent.reason && agent.reason !== 'task-required' && <small>{availabilityReasonLabel(agent.reason)}</small>}<AgentConnectionSteps agent={agent} /><AgentRuntimeAuthenticationNotice agent={agent} />{agent.lastError && <small role="status">{agent.lastError}</small>}{agent.version && <small>版本 {agent.version}</small>}<AgentInstallationDiagnostic agent={agent} /></details><Button compact variant="ghost" disabled={checking[agent.id]} onClick={() => void check(agent)}>{checking[agent.id] ? '检查中…' : '检查连接'} <Icon name="right" size={14} /></Button>{agent.id === 'dsh' && <details className="agent-setup-disclosure"><summary>连接设置</summary><DshSetupPanel agent={agent} onConfigured={configuration => configured(agent.id, { configuration })} /></details>}{isRuntimeProvider(agent.id) && <AgentRuntimeSetupDisclosure agent={agent} onConfigured={runtimeConfiguration => configured(agent.id, { runtimeConfiguration })} onRefresh={() => void check(agent)} />}</Card>)}</div> : !error && <EmptyNotice icon="agents" title="没有匹配的 Agent" detail="当前安装和注册的 Agent 会在这里显示。" />}
    <div className="section-heading page-section-heading"><h2>运行策略</h2></div><Surface className="policy-row"><span className="policy-icon"><Icon name="approval" /></span><span className="grow"><strong>敏感操作需要确认</strong><small>文件写入、网络访问和外部副作用由 Capability Broker 逐次管理。</small></span><Badge tone="success">由 Core 强制执行</Badge></Surface>
  </div>;
}
