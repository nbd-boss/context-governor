import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import { validateJsonSchemaValue } from '../../deepseek-harness/packages/core/tools/src/json-schema.ts'

import type { SessionWorkspaceProvider } from '../src/workspace/session-workspace.ts'
import { registerSubStateTools } from '../src/tools/sub-state-tools.ts'

function readSubStateTool(): ToolDefinition {
  let registered: ToolDefinition | undefined
  const context = {
    tools: {
      register(tool: ToolDefinition) {
        registered = tool
      },
    },
  } as unknown as Context
  registerSubStateTools(context, undefined as unknown as SessionWorkspaceProvider)
  assert.ok(registered)
  return registered
}

test('read_sub_state output accepts a completed Step with no current SubStep', () => {
  const tool = readSubStateTool()
  const output = {
    schema_version: 1,
    sub_state_id: 'sub-state-000001',
    step_id: 'step-000001',
    step_completion_criteria: [{ criterion_id: 'criterion-000001', criterion: 'Rows are verified.' }],
    completed_sub_steps: [{
      sub_step_id: 'sub-step-000001',
      action: 'Collect the rows.',
      completion_criteria: ['Rows are verified.'],
      covers: ['criterion-000001'],
      summary: 'Rows are verified.',
      source_events: ['event-4'],
      artifact_refs: [{ artifact_id: 'artifact-000001', relation: 'produced' }],
    }],
    current_sub_step: null,
    pending_sub_steps: [],
  }
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, output, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.output.schema, { ...output, current_sub_step: 4 }, ''), [])
  assert.match(tool.description, /call read_artifact/)
})
