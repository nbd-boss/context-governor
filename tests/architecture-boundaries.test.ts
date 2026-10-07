import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path: string) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('keeps task models and planning independent from DSH tool wiring', async () => {
  const modelFiles = await Promise.all([
    source('ids.ts'),
    source('state/state-contract.ts'),
    source('planning/planning-core.ts'),
    source('planning/step-plan.ts'),
    source('state/sub-state-contract.ts'),
    source('planning/sub-step-plan.ts'),
    source('evidence/artifact-contract.ts'),
    source('workspace/workspace-validator.ts'),
  ])
  for (const file of modelFiles) {
    assert.doesNotMatch(file, /node:fs|defineTool|@deepseek-ai/)
  }

  const storeFiles = await Promise.all([
    source('state/state-store.ts'),
    source('state/sub-state-store.ts'),
    source('evidence/artifact-store.ts'),
    source('epoch/transition-store.ts'),
  ])
  for (const file of storeFiles) {
    assert.doesNotMatch(file, /defineTool|createUserMessage|tokenMeter/)
  }
})

test('keeps DSH message and token adaptation outside resident Context construction', async () => {
  const resident = await source('epoch/resident-context.ts')
  assert.doesNotMatch(resident, /@deepseek-ai|createUserMessage|tokenMeter/)

  const controller = await source('epoch/epoch-controller.ts')
  assert.match(controller, /createUserMessage|tokenMeter/)
})

test('builds runtime navigation through the shared query service', async () => {
  const resident = await source('epoch/resident-context.ts')
  const tools = await source('tools/sub-state-tools.ts')
  assert.match(resident, /ContextQuery/)
  assert.match(tools, /ContextQuery/)
})
