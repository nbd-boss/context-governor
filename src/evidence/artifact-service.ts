import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { validateArtifact, type Artifact, type ArtifactContains, type ArtifactResourceFormat } from './artifact-contract.ts'
import { nextArtifactId } from '../ids.ts'
import { StructuredArtifactVerifier, type ArtifactVerifier } from './artifact-verifier.ts'
import { resolveWorkspaceFile } from '../workspace/workspace-resource.ts'

export interface ArtifactRegistrationInput {
  contains: ArtifactContains
  resource: { path: string; format: ArtifactResourceFormat }
}

export interface ArtifactReadResult {
  status: 'ready' | 'stale'
  artifact: Artifact
  content?: unknown
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function fieldsFromJson(value: unknown, fields = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) fieldsFromJson(item, fields)
    return fields
  }
  if (value === null || typeof value !== 'object') return fields
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    fields.add(key)
    fieldsFromJson(child, fields)
  }
  return fields
}

function parseJsonl(text: string): unknown[] {
  return text.split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        throw new Error(`Invalid JSONL record at line ${String(index + 1)}`)
      }
    })
}

function parseCsvHeader(text: string): string[] {
  const line = text.split(/\r?\n/, 1)[0] ?? ''
  if (line.trim() === '') throw new Error('CSV Resource must contain a header row')
  const fields: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      fields.push(value.trim())
      value = ''
    } else value += character
  }
  if (quoted) throw new Error('CSV header contains an unterminated quote')
  fields.push(value.trim())
  if (fields.some(field => field === '') || new Set(fields).size !== fields.length) throw new Error('CSV header fields must be non-empty and unique')
  return fields
}

function parseResource(format: ArtifactResourceFormat, bytes: Uint8Array): { content: unknown; fields: Set<string> } {
  const text = new TextDecoder().decode(bytes)
  if (format === 'json') {
    let content: unknown
    try {
      content = JSON.parse(text)
    } catch {
      throw new Error('Invalid JSON Artifact Resource')
    }
    return { content, fields: fieldsFromJson(content) }
  }
  if (format === 'jsonl') {
    const content = parseJsonl(text)
    return { content, fields: fieldsFromJson(content) }
  }
  return { content: text, fields: new Set(parseCsvHeader(text)) }
}

function sameResourcePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === ''
}

/** Verifies structured Resource content before an Artifact may enter an Epoch Delta. */
export class ArtifactService {
  constructor(
    private readonly resourceRoot: string,
    private readonly verifier: ArtifactVerifier = new StructuredArtifactVerifier(),
  ) {}

  async register(input: ArtifactRegistrationInput, existingArtifacts: readonly Artifact[]): Promise<Artifact> {
    const inputArtifact = validateArtifact({
      schema_version: 1,
      artifact_id: 'artifact-000001',
      contains: input.contains,
      resource: { path: input.resource.path, format: input.resource.format, content_sha256: '0'.repeat(64) },
    })
    const path = await resolveWorkspaceFile(this.resourceRoot, inputArtifact.resource.path, 'Artifact Resource')
    const bytes = await readFile(path)
    const contentSha256 = sha256(bytes)
    const existing = existingArtifacts.map(artifact => validateArtifact(artifact))
    const owner = existing.find(artifact => sameResourcePath(artifact.resource.path, path))
    if (owner !== undefined) {
      if (owner.resource.content_sha256 === contentSha256) {
        throw new Error(`Artifact Resource path is already registered by ${owner.artifact_id}; reference that Artifact as used instead of registering it again.`)
      }
      throw new Error(`Artifact Resource path is already owned by ${owner.artifact_id} and its content has changed. Registered Artifact Resources are immutable; write the revised result to a new absolute path before registering it.`)
    }
    const parsed = parseResource(inputArtifact.resource.format, bytes)
    this.verifier.verify({ contains: inputArtifact.contains, available_fields: parsed.fields })
    return validateArtifact({
      schema_version: 1,
      artifact_id: nextArtifactId(existing.map(artifact => artifact.artifact_id)),
      contains: inputArtifact.contains,
      resource: { path, format: inputArtifact.resource.format, content_sha256: contentSha256 },
    })
  }

  async read(artifact: Artifact): Promise<ArtifactReadResult> {
    const checked = validateArtifact(artifact)
    let path: string
    let bytes: Uint8Array
    try {
      path = await resolveWorkspaceFile(this.resourceRoot, checked.resource.path, 'Artifact Resource')
      bytes = await readFile(path)
    } catch (error: unknown) {
      if (isMissingFile(error)) return { status: 'stale', artifact: checked }
      throw error
    }
    if (sha256(bytes) !== checked.resource.content_sha256) return { status: 'stale', artifact: checked }
    const parsed = parseResource(checked.resource.format, bytes)
    this.verifier.verify({ contains: checked.contains, available_fields: parsed.fields })
    return { status: 'ready', artifact: checked, content: parsed.content }
  }
}
