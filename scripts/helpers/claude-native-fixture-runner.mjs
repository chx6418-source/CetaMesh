// Real production runner and exact audited SDK. The sole transport adaptation is
// trusting this test's private loopback TLS certificate in its owned CLI process.
import {runClaudeSdkRunner} from '../../src/agent/claude-sdk-runner.js';
import {loadClaudeSdkResource} from '../../src/agent/claude-sdk-resource.js';
const [resourceRoot,certificate]=process.argv.slice(2);
await runClaudeSdkRunner({loadSdk:async()=>{
 const sdk=await loadClaudeSdkResource({resourceRoot});
 return {query:request=>sdk.query({...request,options:{...request.options,
  env:{...request.options.env,NODE_EXTRA_CA_CERTS:certificate,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'}}})};
}});
