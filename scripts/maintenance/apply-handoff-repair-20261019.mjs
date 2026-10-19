// Temporary branch-scoped implementation runner; exact decompressed payload is SHA-256 verified.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const branch='fix/handoff-context-working-memory-20261019';
const baseline='db2b060018d0309052eeea004cdbd14e257aa56d';
if(process.env.GITHUB_REPOSITORY!=='chx6418-source/whalebridge'||process.env.GITHUB_REF!==`refs/heads/${branch}`)throw new Error('Repair branch only');
const out='output/handoff-repair-20261019';fs.mkdirSync(out,{recursive:true});
const results=[];
function command(name,executable,args,limit=600000){const r=spawnSync(executable,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:limit});const text=(r.stdout??'')+'\n'+(r.stderr??'');fs.writeFileSync(path.join(out,name+'.log'),text);console.log(`STEP ${name}: exit=${r.status}`);console.log(text.slice(-14000));results.push({name,exitCode:r.status,error:r.error?.message??null});return{...r,text};}
function git(...args){const r=spawnSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024});if(r.status!==0)throw new Error('git failed: '+r.stderr);return r.stdout.trim();}
const head=git('rev-parse','HEAD');
const npm=path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
let encoded=fs.readFileSync('scripts/maintenance/handoff-repair-payload-20261019.b64','utf8').trim();
// Repair six identified text-copy defects before validating the original immutable payload.
for(const [before,after] of [['Ft5kyKfeXyYbo3ie','Ft5kyKfeX4Ybo3ie'],['KzJsvLqLqbpSG','KzJsvLqbpSG'],['+dd/+cdd/+9','+dd/+9'],['7H6p7c7wvJCe','7H6p7wvJCe'],['SN7Cpc5dpc5MJ','SN7Cpc5MJ'],['JjUvhi7/tuvhi7/x6Q','JjUvhi7/x6Q']])encoded=encoded.replace(before,after);
const payloadBytes=zlib.gunzipSync(Buffer.from(encoded,'base64'));
if(crypto.createHash('sha256').update(payloadBytes).digest('hex')!=='b38ee7b9d66260b482315672aada1ea6b9675fc220d14f846e0ceab4b5049d65')throw new Error('Repair payload checksum mismatch');
const payload=JSON.parse(payloadBytes.toString('utf8'));
const touched=[...new Set(payload.changes.map(row=>row.file))];
for(const file of touched){if(git('rev-parse',`${baseline}:${file}`)!==git('rev-parse',`HEAD:${file}`))throw new Error('Base changed: '+file);}
const projected=new Map();
for(const row of payload.changes){let source=projected.get(row.file)??fs.readFileSync(row.file,'utf8').replaceAll('\r\n','\n');const count=source.split(row.before).length-1;if(count<1||(!row.all&&count!==1))throw new Error(`Patch anchor drift: ${row.file} count=${count} anchor=${row.before.slice(0,100)}`);projected.set(row.file,row.all?source.split(row.before).join(row.after):source.replace(row.before,row.after));}
const reg='scripts/run-all-tests.mjs';const registry=fs.readFileSync(reg,'utf8').replaceAll('\r\n','\n');
const testName='test-handoff-context-working-memory.mjs';if(registry.includes("'"+testName+"'"))throw new Error('Test already registered; use a follow-up commit instead');
fs.writeFileSync(reg,registry.replace('const REGISTRY = {',`const REGISTRY = {\n  '${testName}': { category: 'runtime', timeoutMs: 120000, note: 'Agent Handoff context and task-scoped working Memory regressions' },`));
for(const[file,content]of Object.entries(payload.tests)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
const red=command('01-red',process.execPath,[npm,'test','--','--suite',testName.replace('.mjs','')],180000);
if(red.status===0||!red.text.includes('FAIL HANDOFF'))throw new Error('Baseline did not demonstrate the reported regression; refusing implementation');
for(const[file,content]of projected)fs.writeFileSync(file,content);
for(const[file,content]of Object.entries(payload.newFiles)){if(fs.existsSync(file))throw new Error('New file unexpectedly exists: '+file);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
for(const file of [...touched,...Object.keys(payload.newFiles),...Object.keys(payload.tests)]){if(file.endsWith('.js')||file.endsWith('.mjs')){const r=command('syntax-'+file.replaceAll('/','_'),process.execPath,['--check',file],30000);if(r.status!==0)throw new Error('Syntax check failed: '+file);}}
const green=command('02-green',process.execPath,[npm,'test','--','--suite',testName.replace('.mjs','')],180000);
if(green.status!==0)throw new Error('Targeted regression is not green; no product commit has been made');
const suites=['test-latest-audit-agent-identity','test-phase3-task-handoff','test-smart-platform-routing','test-task-runtime','test-memory-runtime','test-phase4-memory','test-continuity-rollover','test-continuity-auto-rollover','test-desktop-chat-product','test-error-hygiene'];
const regression=command('03-related-regressions',process.execPath,[npm,'test','--',...suites.flatMap(s=>['--suite',s])],900000);
const uiInstall=command('04-ui-install',process.execPath,[npm,'--prefix','desktop-ui','ci'],180000);
if(uiInstall.status===0)command('05-ui-build',process.execPath,[npm,'run','build:ui'],180000);
command('06-full-suite',process.execPath,[npm,'test'],1200000);
const productFiles=[...touched,...Object.keys(payload.newFiles),...Object.keys(payload.tests),reg];
const diff=git('diff','--stat','--',...productFiles);console.log(diff);
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({baseline,head,branch,results,productFiles,realExternalE2E:false,mainModified:false,userDataTouched:false},null,2));
const report='HANDOFF_CONTEXT_WORKING_MEMORY_REPAIR_20261019.md';
fs.writeFileSync(report,['# Agent handoff / context / working Memory repair','',`Base: ${baseline}`,`Execution source: ${head}`,`Repair branch: ${branch}`,'','## Actual verification',...results.filter(r=>!r.name.startsWith('syntax-')).map(r=>`- ${r.name}: exit ${r.exitCode}${r.error?' / '+r.error:''}`),'','The synthetic production-composition regression was observed failing before source changes and passing afterwards.','Real DSH/Codex/API and Windows desktop manual E2E were NOT run. This is not a Stable release.','Full-suite failures, if any, remain blockers and are not converted to PASS. See accompanying text logs.','','## Scope','- Correct nullable selection policy versus actual Task Session ownership.','- Synchronize committed Task assignments, including lazy recovery of a missed Chat projection.','- Exclude the Core-identified bootstrap turn; preserve existing checkpoint and nextAction.','- Capture bounded Owner-reference context with source IDs; later corrections take precedence.','- Project task-scoped working Memory through existing Memory Runtime without broadening Agent grants.','- Keep user/global long-term approval rules unchanged.','','## Remaining boundaries','- Reference windows are bounded; omitted/truncated entries are marked, not silently invented.','- Cross-provider native model compatibility and real external memory retrieval need separate E2E.','- First Agent report is labeled unverified; arbitrary final prose is not completed work.','- No user data migration, no main merge, no Stable publication.','',diff].join('\n'));
const evidenceDir='docs/repair-evidence/handoff-20261019';fs.mkdirSync(evidenceDir,{recursive:true});
for(const name of ['01-red.log','02-green.log','03-related-regressions.log','06-full-suite.log','summary.json'])if(fs.existsSync(path.join(out,name)))fs.copyFileSync(path.join(out,name),path.join(evidenceDir,name.endsWith('.log')?name.replace('.log','.txt'):name));
git('config','user.name','CetaMesh repair automation');git('config','user.email','repair@users.noreply.github.com');
git('add','--',...productFiles,report,evidenceDir);
git('commit','-m','fix: preserve handoff checkpoints, synchronize Task ownership and record scoped working context');
const committed=git('rev-parse','HEAD');
git('push','origin',`HEAD:refs/heads/${branch}`);
console.log('PRODUCT_COMMIT '+committed);console.log('RELATED_REGRESSIONS_EXIT '+regression.status);
