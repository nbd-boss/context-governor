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
    step_id: 'step-000001',
    next_sub_step_number: 2,
    step_completion_criteria: [{ criterion_id: 'criterion-000001', criterion: 'Rows are verified.' }],
    superseded_criterion_ids: [],
    completed_sub_steps: [{
      sub_step_id: 'sub-step-000001',
      action: 'Collect the rows.',
      covers: ['criterion-000001'],
      summary: 'Rows are verified.',
      criterion_evidence: [{ criterion_id: 'criterion-000001', source_events: ['event-4'] }],
      artifact_refs: [{ artifact_id: 'artifact-000001', relation: 'produced' }],
    }],
    current_sub_step: null,
    pending_sub_steps: [],
    artifact_catalog: [{
      artifact_id: 'artifact-000001',
      contains: { kind: 'rows', summary: 'Verified rows.', coverage: 'The source rows.', key_facts: ['Rows are verified.'], available_fields: ['id'] },
    }],
  }
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, output, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.output.schema, { ...output, current_sub_step: 4 }, ''), [])
  assert.match(tool.description, /call read_artifact/)
  assert.match(tool.description, /each referenced Artifact summary once/)
})
