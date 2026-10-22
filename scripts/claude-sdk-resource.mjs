import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isBuiltin } from 'node:module';
import { readJsonFile } from '../src/storage/json-file.js';
import { CLAUDE_SDK_VERSION, CLAUDE_SDK_SOURCE_SHA256, CLAUDE_SDK_RESOURCE_FILE, verifyClaudeSdkBytes } from '../src/agent/claude-sdk-resource.js';
/** Optional build input; absent source means no resource and unavailable provider.
 * write:false is deliberately reusable for static validation without a Core/SEA build.
 */
export async function compileClaudeSdkResource(sourceDir) {
  const pkg = readJsonFile(path.join(sourceDir,'package.json'));
  const source = fs.readFileSync(path.join(sourceDir,'sdk.mjs'));
  if (pkg.name !== '@anthropic-ai/claude-agent-sdk' || pkg.version !== CLAUDE_SDK_VERSION ||
      crypto.createHash('sha256').update(source).digest('hex') !== CLAUDE_SDK_SOURCE_SHA256) throw Error('CLAUDE_SDK_SOURCE_UNVERIFIED');
  const esbuild = await import('esbuild');
  if (esbuild.version !== '0.25.12') throw Error('CLAUDE_SDK_BUILD_VERSION_UNVERIFIED');
  const result = await esbuild.build({stdin:{contents:source.toString('utf8'),resolveDir:path.resolve(sourceDir),sourcefile:'sdk.mjs'},
    bundle:true,write:false,platform:'node',format:'cjs',target:'node22',minify:true,legalComments:'none',
    define:{'import.meta.url':'__claudeSdkImportMetaUrl'},
    banner:{js:'var __claudeSdkImportMetaUrl = require("node:url").pathToFileURL(__filename).href;'},metafile:true,logLevel:'silent'});
  if (Object.values(result.metafile.outputs).some(output=>output.imports.some(item=>!item.external || !isBuiltin(item.path)))) throw Error('CLAUDE_SDK_EXTERNAL_UNVERIFIED');
  return verifyClaudeSdkBytes(Buffer.from(result.outputFiles[0].contents));
}
export async function stageClaudeSdkResource(sourceDir, resourceRoot) {
  if (!sourceDir) return null;
  const bytes = await compileClaudeSdkResource(sourceDir);
  const target = path.join(resourceRoot,CLAUDE_SDK_RESOURCE_FILE);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,bytes);
  // Preserve the official distribution's license and notices alongside bundled code.
  for (const file of ['LICENSE.md','README.md','package.json']) {
    fs.copyFileSync(path.join(sourceDir,file),path.join(path.dirname(target),`claude-0.3.308.${file}`));
  }
  return {version:CLAUDE_SDK_VERSION,file:CLAUDE_SDK_RESOURCE_FILE};
}
