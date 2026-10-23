// Opt-in local browser acceptance. Synthetic controls only; no Core or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { createSuiteSandbox, finalizeSuiteSandbox } from '../src/testing/suite-sandbox.js';
import { terminateSuiteProcessTree } from '../src/testing/suite-process.js';
const uiRoot = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(uiRoot + 'package.json');
const { build } = require('esbuild');
const edge = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
const sandbox = createSuiteSandbox({ suiteId: 'ui-motion-live' });
let failed = true;
try {
  const bundle = await build({ stdin: { resolveDir: uiRoot, loader: 'tsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {Select} from './src/components/primitives/inputs';
    import {MotionPopup} from './src/components/primitives/motion-popup';
    function Fixture(){const [open,setOpen]=useState(false);return <>
      <Select label="fixture models" value="a" onChange={()=>{}}><option value="a">Alpha</option><option value="b">Beta</option></Select>
      <button id="popup-toggle" onClick={()=>setOpen(v=>!v)}>toggle</button>
      <MotionPopup open={open} id="fixture-popup"><button>Popup content</button><Select label="nested models" value="a"><option value="a">Nested Alpha</option><option value="b">Nested Beta</option></Select></MotionPopup>
      <details className="memory-create-panel"><summary>Add memory</summary><div style={{height:80}}>Synthetic content</div></details>
    </>}
    const report={};const wait=ms=>new Promise(r=>setTimeout(r,ms));
    (async()=>{try{
      flushSync(()=>createRoot(document.getElementById('root')).render(<Fixture/>));
      report.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
      const trigger=document.querySelector('[aria-label="fixture models"]');
      flushSync(()=>trigger.click());await wait(80);
      report.selectOpened=!!document.querySelector('[role="listbox"]');
      flushSync(()=>document.querySelectorAll('[role="option"]')[1].click());
      const closing=document.querySelector('[role="listbox"]');
      report.selectExitSafe=!closing||(closing.inert&&closing.getAttribute('aria-hidden')==='true');
      report.focusReturned=document.activeElement===trigger;
      await wait(500);report.selectRemoved=!document.querySelector('[role="listbox"]');
      const toggle=document.getElementById('popup-toggle');
      flushSync(()=>toggle.click());await wait(80);flushSync(()=>toggle.click());
      flushSync(()=>toggle.click());await wait(300);
      report.reopened=!!document.getElementById('fixture-popup')&&!document.getElementById('fixture-popup').inert;
      flushSync(()=>document.querySelector('[aria-label="nested models"]').click());await wait(80);
      report.nestedOpened=!!document.querySelector('[role="listbox"][aria-label="nested models"]');
      flushSync(()=>toggle.click());
      const nestedClosing=document.querySelector('[role="listbox"][aria-label="nested models"]');
      report.nestedExitSafe=!nestedClosing||nestedClosing.inert;
      await wait(500);
      report.popupRemoved=!document.getElementById('fixture-popup')&&!document.querySelector('[role="listbox"]');
      const details=document.querySelector('details');details.open=true;await wait(300);
      report.disclosureVisible=details.getBoundingClientRect().height>80;
      report.detailsSupport=CSS.supports('interpolate-size','allow-keywords')&&CSS.supports('selector(details::details-content)');
      if(report.reduced)report.reducedAnimations=document.getAnimations().length===0;
    }catch(e){report.error=String(e?.message||e)}finally{document.getElementById('result').textContent=encodeURIComponent(JSON.stringify(report))}})();`
  }, bundle: true, write: false, minify: true, format: 'iife', platform: 'browser', jsx: 'automatic' });
  const css = ['theme/tokens.css', 'theme/global.css', 'app/harbor.css', 'theme/motion.css'].map(file => fs.readFileSync(path.join(uiRoot, 'src', file), 'utf8')).join('\n');
  const fixture = path.join(sandbox.root, 'fixture.html');
  fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="root"></div><pre id="result"></pre><script>' + bundle.outputFiles[0].text + '</script>');
  for (const reduced of [false, true, 'early-failure']) {
    const earlyFailure = reduced === 'early-failure';
    const profile = path.join(sandbox.root, earlyFailure ? 'early-failure-profile' : reduced ? 'reduced-profile' : 'normal-profile');
    const child = spawn(edge, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile,
      ...(reduced === true ? ['--force-prefers-reduced-motion'] : []), 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let launchError, socket;
    child.on('error', error => { launchError = error; });
    try {
      if (earlyFailure) { await delay(300); throw Error('fixture CDP setup failure'); }
      const portFile = path.join(profile, 'DevToolsActivePort');
      for (let attempt = 0; !fs.existsSync(portFile) && attempt < 100 && !launchError; attempt++) await delay(100);
      assert.equal(launchError, undefined, launchError?.message);
      assert.ok(fs.existsSync(portFile), 'owned browser exposes its temporary debugging endpoint');
      const [portText, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      assert.match(portText, /^\d+$/); assert.ok(Number(portText) > 0 && Number(portText) < 65536);
      assert.match(browserPath, /^\/devtools\/browser\/[a-z0-9-]+$/i);
      socket = new WebSocket('ws://127.0.0.1:' + portText + browserPath);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(Error('owned browser connection timed out')); }, 3000);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
      });
      let sequence = 0;
      const pending = new Map();
      socket.on('message', data => {
        const result = JSON.parse(String(data));
        const callback = pending.get(result.id);
        if (callback) { pending.delete(result.id); callback(result); }
      });
      const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('Browser RPC timed out: ' + method)); }, 5000);
        pending.set(id, response => { clearTimeout(timer); response.error ? reject(Error(response.error.message)) : resolve(response.result); });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
      const { targetId } = await rpc('Target.createTarget', { url: pathToFileURL(fixture).href });
      const { sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true });
      let encoded = '';
      for (let attempt = 0; !encoded && attempt < 100; attempt++) {
        const value = await rpc('Runtime.evaluate', { expression: 'document.getElementById("result")?.textContent || ""', returnByValue: true }, sessionId);
        encoded = value.result?.value || '';
        if (!encoded) await delay(100);
      }
      assert.ok(encoded, 'browser produced an asynchronous result');
      const report = JSON.parse(decodeURIComponent(encoded));
      assert.equal(report.error, undefined, JSON.stringify(report));
      for (const key of ['selectOpened', 'selectExitSafe', 'focusReturned', 'selectRemoved', 'reopened', 'nestedOpened', 'nestedExitSafe', 'popupRemoved', 'disclosureVisible']) {
        assert.equal(report[key], true, key + ': ' + JSON.stringify(report));
      }
      if (reduced) assert.ok(report.reduced && report.reducedAnimations, JSON.stringify(report));
      console.log('PASS browser motion lifecycle ' + JSON.stringify(report));
    } catch (error) {
      if (!earlyFailure || error.message !== 'fixture CDP setup failure') throw error;
    } finally {
      try {
        // Edge's launcher may exit before its browser. Recover the endpoint
        // from this exact profile when setup failed before socket assignment.
        if (socket?.readyState !== WebSocket.OPEN) {
          if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
          const portFile = path.join(profile, 'DevToolsActivePort');
          for (let attempt = 0; !fs.existsSync(portFile) && attempt < 60; attempt++) await delay(50);
          if (fs.existsSync(portFile)) {
            const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
            assert.match(port, /^\d+$/); assert.ok(Number(port) > 0 && Number(port) < 65536);
            assert.match(browserPath, /^\/devtools\/browser\/[a-z0-9-]+$/i);
            socket = new WebSocket('ws://127.0.0.1:' + port + browserPath);
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => { socket.terminate(); reject(Error('owned browser cleanup connection timed out')); }, 3000);
              socket.once('open', () => { clearTimeout(timer); resolve(); });
              socket.once('error', error => { clearTimeout(timer); reject(error); });
            });
          }
        }
        if (socket?.readyState === WebSocket.OPEN) {
          // Endpoint was read from this run's marked profile. Close only that browser.
          socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
          await Promise.race([new Promise(resolve => socket.once('close', resolve)), delay(2000)]);
        }
      } finally {
        if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
        for (let attempt = 0; child.pid && child.exitCode === null && child.signalCode === null && attempt < 20; attempt++) await delay(50);
        // Only an unexited child handle is eligible: never target a stale PID,
        // other Edge processes, or a process selected by executable name.
        if (child.pid && child.exitCode === null && child.signalCode === null) await terminateSuiteProcessTree(child);
        for (let attempt = 0; child.pid && child.exitCode === null && child.signalCode === null && attempt < 30; attempt++) await delay(100);
        assert.ok(!child.pid || child.exitCode !== null || child.signalCode !== null, 'owned browser child exited');
      }
    }
    if (earlyFailure) console.log('PASS early browser setup failure terminates and awaits only the owned child tree');
  }
  failed = false;
} finally {
  // Edge releases its owned profile asynchronously. Never terminate user browsers.
  for (let attempt = 0; ; attempt++) {
    try { finalizeSuiteSandbox({ sandbox, failed }); break; }
    catch (error) { if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code) || attempt >= 16) throw error; await delay(250); }
  }
}
