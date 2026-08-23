import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskDir } from '../board.ts';
test('task directory is deterministic',()=>assert.match(taskDir('x'),/tasks\/x$/));
