import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve } from 'node:path'

export type TransitionFileKind = 'artifact' | 'sub_state' | 'state'

export interface PreparedTransitionFile {
  kind: TransitionFileKind
  relative_path: string
  base_sha256: string | null
  target_sha256: string
  staged_path: string
}

export interface TransitionManifest {
  schema_version: 1
  base_state_revision: number | null
  target_state_revision: number
  files: PreparedTransitionFile[]
}

export interface TransitionTargetFile {
  kind: TransitionFileKind
  relative_path: string
  base_content: string | undefined
  target_content: string
}

export interface TransitionInstallOptions {
  /** Test-only interruption point. Production callers do not provide it. */
  before_install?: (file: PreparedTransitionFile) => Promise<void> | void
  /** Test-only interruption point after an atomic install but before cleanup. */
  after_install?: (file: PreparedTransitionFile) => Promise<void> | void
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function validateRelativePath(path: string): string {
  if (typeof path !== 'string' || path === '' || path.includes('..') || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`Invalid transaction relative path: ${String(path)}`)
  }
  const normalized = normalize(path).replaceAll('\\', '/')
  if (!/^(?:state\.json|sub_states\/sub-state-\d+\.json|artifacts\/artifact-\d+\.json)$/.test(normalized)) {
    throw new Error(`Unsupported transaction path: ${path}`)
  }
  return normalized
}

function validateManifest(value: unknown): TransitionManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Transition manifest must be an object')
  const record = value as Record<string, unknown>
  if (record.schema_version !== 1 || !Array.isArray(record.files) || typeof record.target_state_revision !== 'number') {
    throw new Error('Invalid transition manifest')
  }
  if (record.base_state_revision !== null && typeof record.base_state_revision !== 'number') throw new Error('Invalid transition manifest base_state_revision')
  const files = record.files.map((value, index) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid transition manifest file ${String(index)}`)
    const file = value as Record<string, unknown>
    if ((file.kind !== 'artifact' && file.kind !== 'sub_state' && file.kind !== 'state')
      || typeof file.target_sha256 !== 'string' || typeof file.staged_path !== 'string'
      || (file.base_sha256 !== null && typeof file.base_sha256 !== 'string')) {
      throw new Error(`Invalid transition manifest file ${String(index)}`)
    }
    return {
      kind: file.kind,
      relative_path: validateRelativePath(file.relative_path),
      base_sha256: file.base_sha256,
      target_sha256: file.target_sha256,
      staged_path: validateStagedPath(file.staged_path),
    } as PreparedTransitionFile
  })
  if (files.length === 0 || files.filter(file => file.kind === 'state').length !== 1) throw new Error('Transition manifest must contain one State file')
  const paths = new Set(files.map(file => file.relative_path))
  if (paths.size !== files.length) throw new Error('Transition manifest contains duplicate paths')
  return {
    schema_version: 1,
    base_state_revision: record.base_state_revision,
    target_state_revision: record.target_state_revision,
    files,
  }
}

function validateStagedPath(path: string): string {
  if (!/^staging\/\d{4}\.json$/.test(path)) throw new Error(`Invalid transition staged path: ${path}`)
  return path
}

/**
 * Persists one recoverable workspace transaction. It only knows JSON bytes,
 * hashes, and file order; State/SubState rules stay in the application layer.
 */
export class TransitionStore {
  private readonly transitionDirectory: string
  private readonly manifestPath: string
  private readonly stagingDirectory: string

  constructor(private readonly workspaceDirectory: string) {
    this.transitionDirectory = join(workspaceDirectory, 'transition')
    this.manifestPath = join(this.transitionDirectory, 'manifest.json')
    this.stagingDirectory = join(this.transitionDirectory, 'staging')
  }

  async prepare(
    baseStateRevision: number | null,
    targetStateRevision: number,
    targets: readonly TransitionTargetFile[],
  ): Promise<TransitionManifest> {
    if (await this.readManifest() !== undefined) throw new Error('A Context boundary transaction is already pending recovery')
    if (targets.length === 0) throw new Error('A Context boundary transaction must change at least one file')
    await rm(this.stagingDirectory, { recursive: true, force: true })
    await mkdir(this.stagingDirectory, { recursive: true })
    const files: PreparedTransitionFile[] = []
    for (const [index, target] of targets.entries()) {
      const relativePath = validateRelativePath(target.relative_path)
      const stagedPath = `staging/${String(index).padStart(4, '0')}.json`
      const stagedAbsolute = this.resolveTransitionPath(stagedPath)
      await this.writeAtomic(stagedAbsolute, target.target_content)
      files.push({
        kind: target.kind,
        relative_path: relativePath,
        base_sha256: target.base_content === undefined ? null : sha256(target.base_content),
        target_sha256: sha256(target.target_content),
        staged_path: stagedPath,
      })
    }
    const manifest: TransitionManifest = { schema_version: 1, base_state_revision: baseStateRevision, target_state_revision: targetStateRevision, files }
    await this.writeAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  }

  async commitPrepared(options: TransitionInstallOptions = {}): Promise<void> {
    const manifest = await this.requireManifest()
    const state = manifest.files.find(file => file.kind === 'state')!
    if (await this.hasHash(this.resolveWorkspacePath(state.relative_path), state.target_sha256)) {
      await this.clear()
      return
    }
    const ordered = [...manifest.files].sort((left, right) => fileOrder(left.kind) - fileOrder(right.kind))
    for (const file of ordered) {
      const destination = this.resolveWorkspacePath(file.relative_path)
      if (await this.hasHash(destination, file.target_sha256)) continue
      const actualHash = await this.readHash(destination)
      if (actualHash !== file.base_sha256) {
        throw new Error(`Cannot recover Context transaction: ${file.relative_path} changed outside the transaction`)
      }
      const staged = await readFile(this.resolveTransitionPath(file.staged_path), 'utf8')
      if (sha256(staged) !== file.target_sha256) throw new Error(`Staged Context transaction file hash mismatch: ${file.relative_path}`)
      await options.before_install?.(file)
      await this.writeAtomic(destination, staged)
      if (!await this.hasHash(destination, file.target_sha256)) throw new Error(`Context transaction install hash mismatch: ${file.relative_path}`)
      await options.after_install?.(file)
    }
    await this.clear()
  }

  /** Resume a manifest left by an interrupted boundary. Safe to call repeatedly. */
  async recover(): Promise<boolean> {
    const manifest = await this.readManifest()
    if (manifest === undefined) return false
    await this.commitPrepared()
    return true
  }

  private async requireManifest(): Promise<TransitionManifest> {
    const manifest = await this.readManifest()
    if (manifest === undefined) throw new Error('No Context boundary transaction is pending')
    return manifest
  }

  private async readManifest(): Promise<TransitionManifest | undefined> {
    try {
      return validateManifest(JSON.parse(await readFile(this.manifestPath, 'utf8')))
    } catch (error: unknown) {
      if (isMissingFile(error)) return undefined
      throw error
    }
  }

  private async clear(): Promise<void> {
    await rm(this.transitionDirectory, { recursive: true, force: true })
  }

  private resolveWorkspacePath(path: string): string {
    return this.resolveInside(this.workspaceDirectory, path)
  }

  private resolveTransitionPath(path: string): string {
    return this.resolveInside(this.transitionDirectory, path)
  }

  private resolveInside(root: string, path: string): string {
    const rootPath = resolve(root)
    const candidate = resolve(rootPath, path)
    if (relative(rootPath, candidate).startsWith('..')) throw new Error(`Transaction path escapes its root: ${path}`)
    return candidate
  }

  private async readHash(path: string): Promise<string | null> {
    try {
      return sha256(await readFile(path, 'utf8'))
    } catch (error: unknown) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  private async hasHash(path: string, expected: string): Promise<boolean> {
    return (await this.readHash(path)) === expected
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  }
}

function fileOrder(kind: TransitionFileKind): number {
  return kind === 'artifact' ? 0 : kind === 'sub_state' ? 1 : 2
}
