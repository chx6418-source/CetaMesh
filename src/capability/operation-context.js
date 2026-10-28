// Only a fixed, non-secret test command can be carried as executable continuation input.
// All other operations retain opaque fingerprints and require exact explicit input.
export function safeContinuationInput(capability,input) {
 if(capability!=='test.run'||!input||typeof input!=='object'||Array.isArray(input)
  ||Object.keys(input).some(key=>!['tool','args','timeoutMs'].includes(key))||input.tool!=='npm'
  ||!Array.isArray(input.args)||input.args.length!==1||input.args[0]!=='test'
  ||(input.timeoutMs!==undefined&&(!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1000||input.timeoutMs>600000)))return null;
 return structuredClone(input);
}
