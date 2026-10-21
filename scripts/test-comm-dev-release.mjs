// Reuse every installed-release assertion on the explicitly DEV-labelled artifact.
// This does not satisfy the separate clean-source formal RC availability gate.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadReleaseVersion,releaseArtifactDirectory} from '../src/release/version.js';
import {readJsonFile} from '../src/storage/json-file.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=releaseArtifactDirectory({rootDir:root,...loadReleaseVersion({rootDir:root}),channel:'dev'});
assert.ok(fs.existsSync(path.join(directory,'release-manifest.json')),'Build explicit --dev artifact before DEV release integration');
const manifest=readJsonFile(path.join(directory,'release-manifest.json'));
assert.equal(manifest.dirtySourceTree,true,'This suite is explicitly a working-tree DEV verification');
const previous=process.env.WHALEBRIDGE_RC_DIR;
try {process.env.WHALEBRIDGE_RC_DIR=directory;console.log('VERIFIED_RELEASE_INTEGRATION: DEV artifact, formal RC remains blocked');await import('./test-release-candidate.mjs');}
finally {if(previous===undefined)delete process.env.WHALEBRIDGE_RC_DIR;else process.env.WHALEBRIDGE_RC_DIR=previous;}
