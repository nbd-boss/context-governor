import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseArtifactId, type ArtifactId } from '../ids.ts'
import { validateArtifact, type Artifact } from './artifact-contract.ts'

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function fileName(artifactId: ArtifactId): string {
  return `${artifactId}.json`
}

/** Read immutable Artifact metadata; Workspace transactions own all writes. */
export class ArtifactStore {
  constructor(private readonly directory: string) {}

  async read(artifactId: string): Promise<Artifact | undefined> {
    const id = parseArtifactId(artifactId)
    try {
      return validateArtifact(JSON.parse(await readFile(join(this.directory, fileName(id)), 'utf8')))
    } catch (error: unknown) {
      if (isMissingFile(error)) return undefined
      throw error
    }
  }

  async readAll(): Promise<Artifact[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error: unknown) {
      if (isMissingFile(error)) return []
      throw error
    }
    return Promise.all(names
      .filter(name => /^artifact-\d+\.json$/.test(name))
      .sort()
      .map(async name => validateArtifact(JSON.parse(await readFile(join(this.directory, name), 'utf8')))))
  }
}
