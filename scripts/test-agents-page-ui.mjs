// Run the registered Chromium race and settings interaction against the real UI
// with synthetic DTOs. This is not evidence of external Provider execution.
process.env.CETAMESH_GLOBAL_UI_AGENT_RACE_ONLY = '1';
for (const name of ['CETAMESH_GLOBAL_UI_BASELINE_DIR', 'CETAMESH_GLOBAL_UI_BASELINE_ONLY', 'CETAMESH_GLOBAL_UI_AGENT_ONLY', 'CETAMESH_GLOBAL_UI_PLUGIN_ONLY', 'CETAMESH_GLOBAL_UI_PLUGIN_RACE_ONLY', 'CETAMESH_GLOBAL_UI_HOST_SYNC_ONLY', 'CETAMESH_GLOBAL_UI_BEHAVIOR_ONLY', 'CETAMESH_GLOBAL_UI_EVIDENCE_DIR']) delete process.env[name];
if (process.env.CETAMESH_AGENTS_PAGE_EVIDENCE_DIR) process.env.CETAMESH_GLOBAL_UI_EVIDENCE_DIR = process.env.CETAMESH_AGENTS_PAGE_EVIDENCE_DIR;
await import('./test-global-ui-productization.mjs');
