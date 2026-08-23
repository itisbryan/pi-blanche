import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, resolveCrew, phaseOwner, serviceRoles } from '../config.ts';
test('feat crew resolves',()=>{const c=resolveCrew(DEFAULT_CONFIG,'feat');assert.equal(c.roster.length,6);assert.equal(c.phases.length,8);assert.equal(c.specs,true);assert.equal(phaseOwner(c,'PLAN_REVIEW'),'leader');assert.equal(phaseOwner(c,'x'),undefined);assert.deepEqual(serviceRoles(c),['researcher','advisor']);});
test('unknown workflow names known workflows',()=>assert.throws(()=>resolveCrew(DEFAULT_CONFIG,'bad'),/quick/));
