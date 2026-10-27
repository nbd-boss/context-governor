import { readFile } from 'node:fs/promises'

import { validateContextState, type ContextState } from './state-contract.ts'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Cached reader for task-level State; Workspace transactions own all writes. */
export class ContextStateStore {
  private state: ContextState | undefined
  private loaded = false

  constructor(private readonly stateFilePath: string) {}

  async read(): Promise<ContextState | undefined> {
    await this.ensureLoaded()
    return this.state === undefined ? undefined : clone(this.state)
  }

  /** Forget the in-process cache after a transaction installs this file. */
  invalidate(): void {
    this.loaded = false
    this.state = undefined
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      this.state = validateContextState(JSON.parse(await readFile(this.stateFilePath, 'utf8')))
    } catch (error: unknown) {
      if (isMissingFile(error)) return
      throw error
    }
  }
}
