import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ContinuationService } from '../src/epoch/continuation-service.ts'

test('accepts only real absolute working files inside the task workspace', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'context-governor-continuation-service-'))
  const root = join(parent, 'workspace')
  const outside = join(parent, 'outside.json')
  try {
    await mkdir(root)
    const working = join(root, 'working.json')
    await writeFile(working, '{}', 'utf8')
    await writeFile(outside, '{}', 'utf8')
    const service = new ContinuationService(root)
    const checked = await service.validate({
      progress: 'One batch is saved.',
      working_resources: [{ path: working, contains: 'The first batch.' }],
      resume_from: 'Continue with the second batch.',
    })
    assert.equal(checked.working_resources[0]?.path, working)
    await assert.rejects(() => service.validate({
      progress: 'One batch is saved.',
      working_resources: [{ path: 'working.json', contains: 'The first batch.' }],
      resume_from: 'Continue with the second batch.',
    }), /path must be absolute/)
    await assert.rejects(() => service.validate({
      progress: 'One batch is saved.',
      working_resources: [{ path: outside, contains: 'An outside file.' }],
      resume_from: 'Continue with the second batch.',
    }), /must stay inside the allowed workspace/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
