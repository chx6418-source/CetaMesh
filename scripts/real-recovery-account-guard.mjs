// Narrow test-only admission for explicitly authorized subscription acceptance.
// This is not a product authentication or provider parser.
export function assertRecoveryAccount({auth,config,environment={}}){
 const denied=()=>{throw Object.assign(new Error('Only the unambiguous existing ChatGPT account route is authorized'),{code:'CODEX_ACCOUNT_MODE_REQUIRED'});};
 if(auth?.auth_mode!=='chatgpt'||auth.OPENAI_API_KEY||environment.OPENAI_API_KEY||environment.OPENAI_BASE_URL
   ||typeof config!=='string'||Buffer.byteLength(config)>256*1024)denied();
 let root=true;
 for(const raw of config.split(/\r?\n/)){
  const line=raw.trim();if(!line||line.startsWith('#'))continue;
  // Deliberately reject custom/quoted/inline provider definitions and profile
  // overrides rather than claiming to implement another full TOML parser.
  if(/\bmodel_providers\b/.test(line))denied();
  if(/\bmodel_provider\b/.test(line)&&(!root||!/^model_provider\s*=\s*(["'])openai\1\s*(?:#.*)?$/.test(line)))denied();
  if(line.startsWith('['))root=false;
 }
}
