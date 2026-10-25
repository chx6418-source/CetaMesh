const fs = require('node:fs');
const path = require('node:path');

function findImports(source) {
  const imports = [];
  const pattern =
    /(?:from\s+|(?:import|require)\s*\(|import\s+)\s*['"]([^'"]+)['"]/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

function findForbiddenFeatureImports(source) {
  const violations = findImports(source).filter(
    specifier =>
      /(^|\/)(native|data|providers)(\/|$)/.test(specifier) ||
      nativeSdk(specifier),
  );
  if (
    /\b(NativeModules|TurboModuleRegistry)\b/.test(source) &&
    findImports(source).includes('react-native')
  ) {
    violations.push('react-native (native bridge)');
  }
  return violations;
}

function nativeSdk(specifier) {
  return /^(react-native-(keychain|blob-util|image-picker|nitro)|@react-native-documents\/)/.test(
    specifier,
  );
}

function findForbiddenRuntimeImports(source) {
  return findImports(source).filter(
    specifier =>
      /(^|\/)(native|data|providers|features)(\/|$)/.test(specifier) ||
      nativeSdk(specifier) ||
      specifier === 'react-native' ||
      specifier === 'react',
  );
}

function findForbiddenProtocolImports(source) {
  return findImports(source).filter(
    specifier =>
      specifier === 'react-native' ||
      /(^|\/)(native|data|providers|features|runtime|app)(\/|$)/.test(
        specifier,
      ) ||
      nativeSdk(specifier),
  );
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }

    return /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function assertNoForbiddenImports(directory, finder, label) {
  const violations = [];

  for (const file of sourceFiles(directory)) {
    const imports = finder(fs.readFileSync(file, 'utf8'));
    for (const specifier of imports) {
      violations.push(`${path.relative(process.cwd(), file)} -> ${specifier}`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`${label} boundary violation:\n${violations.join('\n')}`);
  }
}

function assertArchitectureBoundaries(
  sourceRoot = path.join(__dirname, '..', 'src'),
) {
  assertNoForbiddenImports(
    path.join(sourceRoot, 'features'),
    findForbiddenFeatureImports,
    'Feature',
  );
  assertNoForbiddenImports(
    path.join(sourceRoot, 'protocol'),
    findForbiddenProtocolImports,
    'Protocol',
  );
  assertNoForbiddenImports(
    path.join(sourceRoot, 'runtime'),
    findForbiddenRuntimeImports,
    'Runtime',
  );
  assertNoForbiddenImports(
    path.join(sourceRoot, 'domain'),
    findForbiddenRuntimeImports,
    'Domain',
  );
}

if (require.main === module) {
  assertArchitectureBoundaries();
  console.log('Architecture boundaries: PASS');
}

module.exports = {
  assertArchitectureBoundaries,
  findForbiddenFeatureImports,
  findForbiddenProtocolImports,
  findForbiddenRuntimeImports,
};
