#!/usr/bin/env node
// Read-only development tool. Success validates draft data; it does not install or authorize it.
import {createProposalValidator, readProposalJson, validateProposalFixtures} from './lib/protocol-proposals.mjs';

try {
  const args=process.argv.slice(2);
  if(args.length===0) {
    const result=validateProposalFixtures();
    for(const row of result.results) console.log(`${row.matched?'PASS':'FAIL'} ${row.file} expected=${row.expected} actual=${row.actual}`);
    console.log(`PROPOSED DTO fixtures: ${result.total-result.failed}/${result.total}; no runtime/permission/Host claims.`);
    process.exitCode=result.failed?1:0;
  } else if(args.length===2) {
    const result=createProposalValidator().validate(args[0],readProposalJson(args[1]));
    console.log(JSON.stringify({status:'PROPOSED',...result}));
    process.exitCode=result.ok?0:1;
  } else {
    console.error('Usage: npm run contracts:validate -- [schema-name path-to-json]');
    process.exitCode=2;
  }
} catch(error) {
  console.error(error.code||'PROPOSAL_VALIDATION_FAILED');
  process.exitCode=1;
}
