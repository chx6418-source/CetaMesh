import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAuthTransport} from '../src/agent/auth/transport.js';
import {claudeAuthProfile} from '../src/agent/auth/claude.js';
if(process.platform!=='win32'||process.env.WHALEBRIDGE_TEST_CLAUDE_AUTH_CONTRACT!=='1') {console.log('NOT_RUN_ENVIRONMENT Windows Claude auth contract opt-in required');process.exit(77);}
const executable=process.env.WHALEBRIDGE_TEST_CLAUDE_AUTH_EXECUTABLE;
if(!executable||!path.isAbsolute(executable)||!fs.existsSync(executable)){console.log('NOT_RUN_ENVIRONMENT explicit native Claude 2.1.308 executable required');process.exit(77);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-claude-auth-native-'));
let confirmed=true;
try {
 const profile=claudeAuthProfile({root,validate(){}},{initialize:true}),transport=createAuthTransport();
 for(const [argv,pattern] of [[['--version'],/^2\.1\.308 \(Claude Code\)/],[['auth','login','--help'],/Usage:.*login/s],[['auth','status','--help'],/Usage:.*status/s]]) {
  confirmed=false;const result=await transport.run({executable,argv,root,environment:profile.environment});confirmed=true;
  assert.match(result.stdout,pattern);profile.validate();
 }
 assert.equal(profile.environment.ANTHROPIC_API_KEY,undefined);assert.equal(profile.environment.ANTHROPIC_AUTH_TOKEN,undefined);
 assert.equal(fs.realpathSync(profile.environment.CLAUDE_CONFIG_DIR),fs.realpathSync(path.join(root,'config')));
 console.log('PASS native Claude pinned command help and private config; no login, credential or model request performed');
 console.log('Account acceptance, ACL/reparse behavior, browser/process cancellation and subscription status remain separate gates');
} finally {if(confirmed)fs.rmSync(root,{recursive:true,force:true});}
