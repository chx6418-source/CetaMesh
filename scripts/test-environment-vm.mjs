import path from 'node:path';
import {environmentTestMain} from './environment-test.mjs';
const optedIn=process.env.CETAMESH_ENV_VM_OPT_IN==='1';
const args=optedIn?['--approve-run','--config',process.env.CETAMESH_ENV_CONFIG || '', '--profile',process.env.CETAMESH_ENV_PROFILE || '', '--state-dir',process.env.CETAMESH_ENV_TEST_STATE || '']:['--preflight'];
args.push('--report',path.resolve('.superpowers/sdd/2026-10-26-agentos-environment/vm-acceptance.json'));
const result=await environmentTestMain(args);
if(['BLOCKED_ENV','NOT_RUN'].includes(result.status) || !optedIn){console.log(`NOT_RUN_ENVIRONMENT: ${optedIn?'Hyper-V or conditional pack prerequisites absent; inspect per-check report':'Explicit VM opt-in and approved Host profile required'}`);process.exitCode=77;}
else if(result.status!=='PASS')throw new Error(`Windows VM acceptance ${result.status}`);
