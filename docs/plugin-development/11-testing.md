# 11 Testing

Run node examples/plugin-template/test.mjs to exercise the Hello Tool with the VM Extension Host, and npm run plugin:validate -- path/to/plugin to validate a directory. Repository regressions are registered with scripts/run-all-tests.mjs; use npm test as the unified suite.

Cover valid and invalid inputs, denied permissions, timeout/cancellation, compatibility bounds, tampered packages, and permission changes on update.
