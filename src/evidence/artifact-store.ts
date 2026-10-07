import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { parseArtifactId, type ArtifactId } from '../ids.ts'
import { validateArtifact, type Artifact } from './artifact-contract.ts'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function fileName(artifactId: ArtifactId): string {
  return `${artifactId}.json`
}

/** Immutable metadata authority for verified Artifacts. It never reads Resources. */
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

  /** Read selected immutable metadata in one directory scan. */
  async readMany(artifactIds: readonly string[]): Promise<Artifact[]> {
    const requested = new Set(artifactIds.map(id => parseArtifactId(id)))
    const all = await this.readAll()
    const found = new Map(all.map(artifact => [artifact.artifact_id, artifact]))
    for (const id of requested) if (!found.has(id)) throw new Error(`Artifact not found: ${id}`)
    return [...requested].map(id => found.get(id)!)
  }

  /** Artifacts are immutable. Boundary recovery writes files directly from staging. */
  async save(value: Artifact): Promise<Artifact> {
    const artifact = validateArtifact(value)
    if (await this.read(artifact.artifact_id) !== undefined) {
      throw new Error(`Artifact already exists and is immutable: ${artifact.artifact_id}`)
    }
    const path = join(this.directory, fileName(artifact.artifact_id))
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
    return clone(artifact)
  }
}
