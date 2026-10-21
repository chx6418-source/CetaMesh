# 01 Getting started

Create a local Hello Tool in about 15–30 minutes.

1. Copy examples/plugin-template and keep extension.json beside index.js.
2. Read its manifest: it declares one hello tool capability and requests no permissions.
3. Implement module.exports.handlers.hello(input, context), returning JSON-compatible data.
4. From the repository root, run node examples/plugin-template/test.mjs. The fixture invokes the sample through the existing VM Extension Host.
5. Validate with npm run plugin:validate -- examples/plugin-template.
6. In Plugin Center, enable Developer Mode, stage the local directory, review it, and install. It remains disabled until separately enabled; local code needs a first-enable Owner Review.

Third-party Catalog extensions use the existing Process Extension Host. Keep the plugin id stable and increment the plugin SemVer when publishing updates.
