#!/usr/bin/env node
// CetaMesh Desktop v1 architecture red-line audit (stage 15).
//
// Source-level invariants only: no processes are started, no user data is touched. These are the
// red lines the product must never regress on; runtime behavior is covered by the functional
// suites (test-system / test-task / test-workspace / test-extension / test-desktop-shell / ...).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const listJs = (relativeDir) =>
  fs
    .readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.posix.join(relativeDir, entry.name));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

// 1. The shipped desktop shell is the native eframe app; Tauri/WebView source is gone.
check('native eframe entry, no Tauri/WebView dependency or obsolete shell files', () => {
  const cargo = read('desktop-shell/Cargo.toml');
  assert.match(cargo, /autobins\s*=\s*false/);
  assert.match(cargo, /path\s*=\s*"src\/native_main\.rs"/);
  assert.match(cargo, /\beframe\s*=/);
  assert.doesNotMatch(cargo, /tauri|wry/i);
  for (const gone of [
    'desktop-shell/src/main.rs',
    'desktop-shell/tauri.conf.json',
    'desktop-shell/ui/index.html',
    'desktop-shell/ui/installer.html',
    'desktop-shell/ui/status.html'
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `obsolete shell artifact remains: ${gone}`);
  }
});

// 2. UI modules must go through the Core IPC runtime for product data and must not control
//    processes. The only allowed process launch is opening the log directory in Explorer, and the
//    only direct file read is the user-initiated, bounded chat attachment drop.
check('UI does not bypass the runtime data/process boundary', () => {
  const uiFiles = [
    'desktop-shell/src/native_ui.rs',
    'desktop-shell/src/chat_ui.rs',
    'desktop-shell/src/task_ui.rs',
    'desktop-shell/src/memory_ui.rs',
    'desktop-shell/src/workspace_ui.rs',
    'desktop-shell/src/mesh_ui.rs',
    'desktop-shell/src/app_shell.rs'
  ];
  for (const file of uiFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /tauri::|WebviewWindowBuilder|WebviewUrl/i, `${file} uses a webview shell`);
    assert.doesNotMatch(
      source,
      /config\.json|task-store\.json|memory-store\.json|workspace-metadata\.json/,
      `${file} references Core data files directly`
    );
    const commands = source.match(/std::process::Command::new\([^)]*\)/g) ?? [];
    for (const command of commands) {
      assert.equal(
        command,
        'std::process::Command::new("explorer.exe")',
        `${file} launches a process outside the Explorer log-directory exception: ${command}`
      );
    }
  }
  const nativeUi = read('desktop-shell/src/native_ui.rs');
  assert.match(nativeUi, /dropped_files/, 'attachment intake should be user-initiated via drag & drop');
  assert.match(nativeUi, /MAX_ATTACHMENT_CHARS/, 'attachment intake must stay bounded');
  const uiPrefs = read('desktop-shell/src/ui_prefs.rs');
  assert.match(uiPrefs, /desktop-ui\.json/, 'UI prefs own exactly one private state file');
  assert.doesNotMatch(uiPrefs, /config\.json/, 'UI prefs must never touch Core config.json');
});

// 3. QQ / SnowLuma is a Channel Adapter: the product runtime must not depend on it.
check('product runtime has no QQ/SnowLuma dependency', () => {
  const productDirs = [
    'src/desktop',
    'src/agent',
    'src/memory',
    'src/task',
    'src/workspace',
    'src/continuity',
    'src/extension'
  ];
  for (const directory of productDirs) {
    for (const file of listJs(directory)) {
      assert.doesNotMatch(read(file), /snowluma/i, `${file} depends on the QQ adapter`);
    }
  }
  const channelRegistry = read('src/channel/registry.js');
  assert.match(channelRegistry, /QQ/, 'QQ stays available as a Channel Adapter');
});

// 4. Legacy reserved modes belong to the adapter; the product flow must not reference them.
check('no legacy reserved mode in the product flow', () => {
  for (const directory of ['src/desktop', 'src/agent', 'src/memory', 'src/task', 'src/workspace', 'src/continuity']) {
    for (const file of listJs(directory)) {
      assert.doesNotMatch(read(file), /\breserved2?\b/, `${file} still references a legacy reserved mode`);
    }
  }
});

// 5. Extensions run sandboxed: no host require/process/fs, static scan forbids dangerous modules.
check('extension host is sandboxed and review-gated', () => {
  const host = read('src/extension/host.js');
  assert.match(host, /vm\.createContext/, 'extension code must run in a vm context');
  assert.doesNotMatch(host, /from 'node:child_process'|require\('node:child_process'\)/);
  assert.match(host, /PERMISSION_DENIED/, 'capability calls must enforce granted permissions');
  const scan = read('src/extension/scan.js');
  for (const marker of ['child_process', 'dynamic-import', 'function-ctor']) {
    assert.ok(scan.includes(marker), `static scan missing rule: ${marker}`);
  }
  assert.match(read('src/extension/review.js'), /requiresExplicitApproval/, 'high-risk permissions need explicit approval');
});

// 6. Workspace boundary and Task independence.
check('workspace boundary and task/agent separation exist in code', () => {
  const boundary = read('src/workspace/boundary.js');
  for (const marker of ['isInsideRoot', 'resolveInside', 'canonicalizeRoot']) {
    assert.ok(boundary.includes(marker), `workspace boundary missing ${marker}`);
  }
  const taskRuntime = read('src/task/runtime.js');
  assert.match(taskRuntime, /attachAgent/, 'agent session must be an attachable reference');
  assert.match(taskRuntime, /currentAgent = null/, 'detaching the agent must not destroy the task');
  assert.match(taskRuntime, /workspaceId/, 'tasks carry a workspace reference, not an agent session identity');
});

// 7. Secret redaction is mandatory infrastructure.
check('logging redaction is present and fail-closed', () => {
  assert.match(read('src/logging/redact.js'), /REDACTION_MARK/);
  assert.match(read('src/logging/index.js'), /createRedactingSink/);
});

// 8. The shipped executable carries real product metadata (unsigned ML heuristics weigh this).
check('desktop executable declares product version metadata', () => {
  const pkg = JSON.parse(read('package.json'));
  const rc = read('desktop-shell/whalebridge.rc');
  assert.match(rc, /VERSIONINFO/, 'Windows VERSIONINFO must be embedded');
  assert.match(rc, /VALUE "ProductName", "CetaMesh Desktop\\0"/);
  assert.match(rc, /VALUE "CompanyName", "CetaMesh\\0"/);
  assert.ok(
    rc.includes(`VALUE "ProductVersion", "${pkg.version}\\0"`),
    `whalebridge.rc ProductVersion must match package.json (${pkg.version})`
  );
});

console.log(`\nDesktop v1 architecture red lines: ${passed} groups PASS`);
