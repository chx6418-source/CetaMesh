// Model identities belong to an executor, not to every Agent that touches a Task.
// Legacy single-executor tasks retain their settings; ambiguous history never
// lends a model authorization to an unrelated executor.
export function taskModelForAgent(task, provider) {
  const config = task?.modelConfig;
  if (!config) return {};
  const history = [...new Set((task.agentHistory ?? []).map(row => row.provider).filter(Boolean))];
  const owner = config.agentProvider ?? (history.length === 1 ? history[0]
    : history.length === 0 ? task.requestedAgentProvider || 'cetamesh' : null);
  return owner === provider ? config : {};
}
