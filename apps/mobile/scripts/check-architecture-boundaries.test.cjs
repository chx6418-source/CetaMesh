const assert = require('node:assert/strict');
const test = require('node:test');

const {
  findForbiddenFeatureImports,
  findForbiddenProtocolImports,
  findForbiddenRuntimeImports,
} = require('./check-architecture-boundaries.cjs');

test('rejects feature imports that bypass the runtime into native providers', () => {
  const source = "import {capture} from '../native/camera';";

  assert.deepEqual(findForbiddenFeatureImports(source), ['../native/camera']);
});

test('allows features to import runtime interfaces', () => {
  const source =
    "import type {CapabilityRuntime} from '../runtime/capability/CapabilityRuntime';";

  assert.deepEqual(findForbiddenFeatureImports(source), []);
});

test('rejects protocol imports that bind to React Native or native providers', () => {
  const source = [
    "import {Platform} from 'react-native';",
    "import camera from '../native/camera';",
  ].join('\n');

  assert.deepEqual(findForbiddenProtocolImports(source), [
    'react-native',
    '../native/camera',
  ]);
});

test('rejects direct SDK and native bridge access from features', () => {
  const source =
    "import fs from 'react-native-blob-util'; import {NativeModules} from 'react-native'; const db=require('../../data/database');";
  assert.deepEqual(findForbiddenFeatureImports(source), [
    'react-native-blob-util',
    '../../data/database',
    'react-native (native bridge)',
  ]);
});
test('runtime cannot import concrete data/provider/native/UI implementations', () => {
  const source =
    "import data from '../../data/repositories/x'; import native from 'react-native-keychain'; import provider from '../../providers/model/x';";
  assert.deepEqual(findForbiddenRuntimeImports(source), [
    '../../data/repositories/x',
    'react-native-keychain',
    '../../providers/model/x',
  ]);
});
