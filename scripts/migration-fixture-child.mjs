// Test-only crash injector, excluded from SEA/Release resources.
import { openFixtureForChild } from '../src/testing/legacy-migration-fixture.js';
const [root, nonce, crashAt, expectedPlan] = process.argv.slice(2);
const fixture = openFixtureForChild({ root, nonce });
const plan = fixture.plan();
if (plan.report.planId !== expectedPlan) throw new Error('fixture plan changed');
fixture.stopWriters();
fixture.apply(plan, { approval: fixture.approve(plan), crashAt, onCrash: () => process.kill(process.pid, 'SIGKILL') });
