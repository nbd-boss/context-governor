import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { validateSubState, type SubState } from './sub-state-contract.ts'

function fileName(subState: Pick<SubState, 'step_id'>): string {
  return `${subState.step_id}.json`
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Read one SubState per started Step. Workspace transactions own all writes
 * and relationship validation.
 */
export class SubStateStore {
  constructor(private readonly directory: string) {}

  async readAll(): Promise<SubState[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error: unknown) {
      if (isMissingFile(error)) return []
      throw error
    }
    return Promise.all(names
      .filter(name => /^step-\d+\.json$/.test(name))
      .sort()
      .map(async name => {
        const subState = validateSubState(JSON.parse(await readFile(join(this.directory, name), 'utf8')))
        if (name !== fileName(subState)) throw new Error(`SubState filename does not match step_id: ${name}`)
        return subState
      }))
  }
}
