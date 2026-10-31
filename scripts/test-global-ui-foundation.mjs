import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const uiRoot=path.resolve(import.meta.dirname,'../desktop-ui');
const require=createRequire(path.join(uiRoot,'package.json'));
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
const vite=await createServer({configFile:false,root:uiRoot,optimizeDeps:{noDiscovery:true},server:{middlewareMode:true},appType:'custom',logLevel:'error'});
try {
  const {Sheet}=await vite.ssrLoadModule('/src/components/primitives/overlays.tsx');
  const html=renderToStaticMarkup(React.createElement(Sheet,{open:true,title:'Scoped review',onClose(){}},React.createElement('button',null,'Review action')));
  assert.match(html,/role="dialog"/,'actual shared drawer exposes modal dialog semantics');
  assert.match(html,/aria-modal="true"/,'assistive technologies know the active drawer is modal');
  assert.match(html,/aria-label="Scoped review"/);
  assert.match(html,/tabindex="-1"/,'drawer has an initial keyboard focus target');
  assert.match(html,/Review action/,'content and callbacks remain available');
  console.log('PASS shared production Drawer semantics and SSR safety; keyboard containment requires separate rendered acceptance');
} finally {await vite.close();}
