import assert from 'node:assert/strict'
import test from 'node:test'

import { BOOTSTRAP_REQUIRED_MESSAGE, bootstrapAllowsTool } from '../src/epoch/bootstrap-gate.ts'

test('bootstrap gate permits only initialization before State exists', () => {
  assert.equal(bootstrapAllowsTool('initialize_context_state', false), true)
  assert.equal(bootstrapAllowsTool('list_recent_tool_results', false), false)
  assert.equal(bootstrapAllowsTool('read_prior_epoch_event', false), false)
})

test('bootstrap gate rejects ordinary work before State exists', () => {
  assert.equal(bootstrapAllowsTool('canvas_list_courses', false), false)
  assert.equal(bootstrapAllowsTool('filesystem_write_file', false), false)
  assert.match(BOOTSTRAP_REQUIRED_MESSAGE, /initialize_context_state/)
})

test('bootstrap gate opens every tool after State exists', () => {
  assert.equal(bootstrapAllowsTool('canvas_list_courses', true), true)
  assert.equal(bootstrapAllowsTool('filesystem_write_file', true), true)
})
