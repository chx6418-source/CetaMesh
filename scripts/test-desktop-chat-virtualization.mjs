#!/usr/bin/env node
// Deterministic React and TanStack virtual-window fixtures for Harbor Chat.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_ROOT = path.join(ROOT, 'desktop-ui');
const uiRequire = createRequire(path.join(UI_ROOT, 'package.json'));
const React = uiRequire('react');
const { renderToStaticMarkup } = uiRequire('react-dom/server');
const { Virtualizer } = uiRequire('@tanstack/virtual-core');
const { createServer } = await import(pathToFileURL(uiRequire.resolve('vite')).href);

// typed-client installs the native bridge on window at module load. This test
// renders Markdown without invoking any bridge action.
globalThis.window = { setTimeout, clearTimeout };

const vite = await createServer({
  configFile: false,
  root: UI_ROOT,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
});

const kinds = ['text', 'markdown', 'code', 'url', 'tools', 'agent', 'approval', 'artifact', 'attachment'];
const makeMessages = count => Array.from({ length: count }, (_, index) => {
  const kind = kinds[index % kinds.length];
  const url = 'https://example.test/' + 'u'.repeat(512);
  return {
    id: 'message-' + (index + 1),
    kind,
    text: kind === 'markdown' ? '# 长 Markdown ' + (index + 1) + '\n\n' + '多段内容用于动态高度验证。 '.repeat(70) :
      kind === 'url' ? '地址 ' + url : '普通对话 ' + (index + 1),
    code: 'export function fixture' + index + '() {\n' + '  return { state: "ready", detail: "long code block" };\n'.repeat(80) + '}',
    activities: Array.from({ length: 6 }, (_, activityIndex) => 'Agent activity ' + (activityIndex + 1)),
    tools: Array.from({ length: 5 }, (_, toolIndex) => 'Tool card ' + (toolIndex + 1)),
    attachment: { name: 'diagram.png', mimeType: 'image/png' }
  };
});

function renderFixture(components, item) {
  if (item.kind === 'markdown' || item.kind === 'url') {
    return React.createElement(components.Markdown, { children: item.text });
  }
  if (item.kind === 'code') {
    return React.createElement(components.CodeBlock, { code: item.code, language: 'typescript' });
  }
  if (item.kind === 'tools') {
    return React.createElement('section', { 'data-kind': 'tools' },
      item.tools.map(label => React.createElement('article', { key: label }, label)));
  }
  if (item.kind === 'agent') {
    return React.createElement('section', { 'data-kind': 'agent' },
      item.activities.map(label => React.createElement('p', { key: label }, label)));
  }
  if (item.kind === 'approval') {
    return React.createElement('section', { 'data-kind': 'approval' },
      React.createElement('strong', null, '等待审批'),
      React.createElement('button', { type: 'button', disabled: true }, '批准一次'));
  }
  if (item.kind === 'artifact') {
    return React.createElement('section', { 'data-kind': 'artifact' },
      React.createElement('strong', null, '启动配置 diff'));
  }
  if (item.kind === 'attachment') {
    return React.createElement('div', { 'data-kind': 'attachment', role: 'img', 'aria-label': item.attachment.name },
      item.attachment.name + ' · ' + item.attachment.mimeType);
  }
  return React.createElement('p', { 'data-kind': 'text' }, item.text);
}

function makeVirtualizer(count, initialOffset = 0) {
  const element = {
    scrollTop: initialOffset,
    scrollHeight: count * 112,
    clientHeight: 600,
    clientWidth: 1280,
    getBoundingClientRect: () => ({ width: 1280, height: 600, top: 0, left: 0 }),
    ownerDocument: { defaultView: null }
  };
  const virtualizer = new Virtualizer({
    count,
    getScrollElement: () => element,
    estimateSize: () => 112,
    getItemKey: index => index === count - 1 ? 'streaming' : 'message-' + (index + 1),
    overscan: 4,
    initialRect: { width: 1280, height: 600 },
    initialOffset,
    scrollToFn: offset => { element.scrollTop = offset; }
  });
  return { element, virtualizer };
}

try {
  const historyModelPath = path.join(UI_ROOT, 'src/app/chat-history.ts');
  assert.ok(fs.existsSync(historyModelPath), 'Chat deduplication uses a testable stable-ID history merge');
  const historyModel = await vite.ssrLoadModule('/src/app/chat-history.ts');
  const asyncChatState = await vite.ssrLoadModule('/src/app/chat-async-state.ts');
  const epochs = new asyncChatState.ChatRequestEpoch();
  const requestA = epochs.begin('load', 'session-a');
  const requestB = epochs.begin('load', 'session-b');
  const requestC = epochs.begin('load', 'session-c');
  assert.equal(epochs.isCurrent(requestA, 'session-c'), false, 'late history/state/memory from A is rejected after switching to C');
  assert.equal(epochs.isCurrent(requestB, 'session-c'), false, 'late history/state/memory from B is rejected after switching to C');
  assert.equal(epochs.isCurrent(requestC, 'session-c'), true, 'the most recent selected session request remains current');
  const completions = [];
  const finishLateRead = async (token, value, signal) => {
    await signal;
    if (epochs.isCurrent(token, 'session-c')) completions.push(value);
  };
  let releaseA; let releaseB; let releaseC;
  const gateA = new Promise(resolve => { releaseA = resolve; });
  const gateB = new Promise(resolve => { releaseB = resolve; });
  const gateC = new Promise(resolve => { releaseC = resolve; });
  const pendingA = finishLateRead(requestA, 'A', gateA);
  const pendingB = finishLateRead(requestB, 'B', gateB);
  const pendingC = finishLateRead(requestC, 'C', gateC);
  releaseB(); await pendingB;
  releaseA(); await pendingA;
  releaseC(); await pendingC;
  assert.deepEqual(completions, ['C'], 'delayed A/B responses finishing out of order cannot replace the current C conversation');
  const repeated = epochs.begin('context', 'session-c');
  assert.equal(epochs.isCurrent(requestC, 'session-c'), true, 'refreshing context does not invalidate the independent current history request');
  assert.equal(epochs.isCurrent(epochs.begin('context', 'session-c'), 'session-c'), true, 'the latest context refresh remains current');
  assert.equal(epochs.isCurrent(repeated, 'session-c'), false, 'an older context refresh cannot overwrite newer context data');
  const streamBase = { displayText: '', requestId: 'request-old', state: 'streaming', retryCount: 0, statusMessage: null, toolActivity: [], agentActivity: null };
  const streamed = asyncChatState.applyChatStreamUpdates(streamBase, [
    { sessionId: 'session-c', requestId: 'request-old', delta: 'stale-before-reset' },
    { sessionId: 'session-c', requestId: 'request-new', reset: true, status: 'starting' },
    ...Array.from({ length: 512 }, (_, index) => ({ sessionId: 'session-c', requestId: 'request-new', delta: String.fromCharCode(65 + index % 26) })),
    { sessionId: 'session-c', requestId: 'request-old', delta: 'stale-after-reset' },
    { sessionId: 'session-b', requestId: 'request-new', delta: 'cross-session' }
  ], 'session-c', 'request-old');
  const expectedStream = Array.from({ length: 512 }, (_, index) => String.fromCharCode(65 + index % 26)).join('');
  assert.equal(streamed.displayText, expectedStream, 'frame batching preserves every ordered delta and rejects stale session/request events');
  const orderedStream = asyncChatState.applyChatStreamUpdates({ ...streamBase, displayText: 'old' }, [
    { sessionId: 'session-c', requestId: 'request-new', reset: true },
    { sessionId: 'session-c', requestId: 'request-new', delta: 'first' },
    { sessionId: 'session-c', requestId: 'request-new', replaceText: 'snapshot' },
    { sessionId: 'session-c', requestId: 'request-new', delta: '+tail' }
  ], 'session-c', 'request-old');
  assert.equal(orderedStream.displayText, 'snapshot+tail', 'reset, replaceText, and delta are applied in event order');
  const latestMerge = historyModel.mergeLatestChatMessages(
    [{ id: 'm1', text: 'one' }, { id: 'm2', text: 'old' }],
    [{ id: 'm2', text: 'updated' }, { id: 'm3', text: 'first event' }, { id: 'm3', text: 'reconnected final' }]
  );
  assert.deepEqual(latestMerge, [
    { id: 'm1', text: 'one' }, { id: 'm2', text: 'updated' }, { id: 'm3', text: 'reconnected final' }
  ], 'reconnect and continuation duplicates merge by stable ID while preserving chronological order');
  const olderMerge = historyModel.prependOlderChatMessages(
    [{ id: 'm1', text: 'fresh current' }, { id: 'm2', text: 'current' }],
    [{ id: 'm-2', text: 'older first' }, { id: 'm-1', text: 'older' }, { id: 'm1', text: 'stale overlap' }, { id: 'm-2', text: 'older updated' }]
  );
  assert.deepEqual(olderMerge, [
    { id: 'm-2', text: 'older updated' }, { id: 'm-1', text: 'older' },
    { id: 'm1', text: 'fresh current' }, { id: 'm2', text: 'current' }
  ], 'older pages prepend in order, dedupe their own overlaps, and retain the fresher current message');
  const components = await vite.ssrLoadModule('/src/components/primitives/content.tsx');
  assert.equal(typeof components.findVisibleVirtualAnchor, 'function', 'VirtualList exposes the anchor selection behavior used by Chat');
  assert.equal(typeof components.scrollTopForAnchor, 'function', 'VirtualList exposes the anchor restoration calculation used by Chat');
  assert.equal(typeof components.isVirtualScrollAtBottom, 'function', 'VirtualList exposes the bottom-stick threshold used by Chat');
  const anchor = components.findVisibleVirtualAnchor([
    { key: 'load-earlier', index: 0, top: 8, bottom: 42 },
    { key: 'message-10', index: 10, top: -6, bottom: 58 },
    { key: 'approval-1', index: 11, top: 58, bottom: 140 }
  ], 0, 120, index => index === 10);
  assert.deepEqual(anchor, { key: 'message-10', offset: -6 }, 'anchor selection skips controls and preserves a visible message offset');
  assert.equal(components.scrollTopForAnchor(800, 0, 0, -6), 806, 'restoration retains the same partially clipped message offset');
  assert.equal(components.isVirtualScrollAtBottom(2200, 1552, 600), true, 'bottom-stick allows its 48px threshold');
  assert.equal(components.isVirtualScrollAtBottom(2200, 1551, 600), false, 'reading history stays detached from the bottom');
  for (const count of [100, 200, 500]) {
    const items = [...makeMessages(count), {
      id: 'streaming', kind: 'streaming', text: '最新 streaming 内容', code: '', tools: [], activities: [], attachment: null
    }];
    let renderCalls = 0;
    const html = renderToStaticMarkup(React.createElement(components.VirtualList, {
      items,
      estimateSize: 112,
      height: 600,
      getItemKey: item => item.id,
      render: item => { renderCalls += 1; return renderFixture(components, item); }
    }));
    const renderedKeys = [...html.matchAll(/data-virtual-key="([^"]+)"/g)].map(match => match[1]);
    assert.ok(renderedKeys.length > 0, count + ' messages: the React VirtualList renders its initial viewport');
    assert.ok(renderedKeys.length < items.length, count + ' messages: DOM rows stay below the full history');
    assert.ok(renderedKeys.length <= 20, count + ' messages: mounted window remains bounded');
    assert.equal(renderCalls, renderedKeys.length, count + ' messages: only mounted rows render');
    assert.equal(new Set(renderedKeys).size, renderedKeys.length, count + ' messages: stable row keys do not duplicate');
    for (const kind of ['tools', 'agent', 'approval', 'artifact', 'attachment']) {
      assert.match(html, new RegExp('data-kind="' + kind + '"'), count + ' messages: ' + kind + ' content is renderable');
    }
    assert.match(html, /code-figure/, count + ' messages: code blocks render');
    assert.match(html, /https:\/\/example\.test\//, count + ' messages: long URLs render');
    const bottomVirtualizer = makeVirtualizer(items.length, items.length * 112 - 600).virtualizer;
    const bottomRows = bottomVirtualizer.getVirtualItems();
    assert.ok(bottomRows.some(row => row.key === 'streaming'), count + ' messages: the latest streaming row is in the bottom window');
    assert.ok(bottomRows.length <= 20, count + ' messages: the bottom window stays bounded');
    process.stdout.write('PASS React VirtualList fixture ' + count + ': ' + renderedKeys.length + '/' + items.length + ' initial rows, ' + bottomRows.length + ' bottom rows\n');
  }

  for (const count of [100, 200, 500]) {
    const virtualizer = makeVirtualizer(count).virtualizer;
    const before = virtualizer.getTotalSize();
    const measuredSizes = [64, 480, 920, 360, 700, 560, 440, 840];
    for (let index = 0; index < measuredSizes.length; index += 1) {
      virtualizer.resizeItem(index, measuredSizes[index]);
    }
    const expected = before + measuredSizes.reduce((delta, size) => delta + size - 112, 0);
    assert.equal(virtualizer.getTotalSize(), expected, count + ' messages: measured dynamic heights update total size');
    assert.ok(virtualizer.getVirtualItems().length <= 20, count + ' messages: dynamic measurement does not mount the full history');
    process.stdout.write('PASS measured virtual rows ' + count + ': total size ' + before + ' -> ' + expected + '\n');
  }
} finally {
  await vite.close();
}
