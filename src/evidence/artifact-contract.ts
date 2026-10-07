import { requireExactKeys, requireText, requireTextList } from '../contract-utils.ts'
import { parseArtifactId, type ArtifactId } from '../ids.ts'

export type ArtifactResourceFormat = 'json' | 'jsonl' | 'csv'

/** Compact facts available without reading the exact Resource. */
export interface ArtifactContains {
  kind: string
  summary: string
  coverage: string
  key_facts: string[]
  available_fields: string[]
}

/** The one immutable file described by an Artifact. */
export interface ArtifactResource {
  path: string
  format: ArtifactResourceFormat
  content_sha256: string
}

/** Target independent Artifact record. Registration and verification arrive in P4. */
export interface Artifact {
  schema_version: 1
  artifact_id: ArtifactId
  contains: ArtifactContains
  resource: ArtifactResource
}

export function validateArtifact(value: unknown): Artifact {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Artifact must be an object')
  const record = value as Record<string, unknown>
  requireExactKeys(record, 'Artifact', ['schema_version', 'artifact_id', 'contains', 'resource'])
  if (record.schema_version !== 1) throw new Error(`Unsupported Artifact schema_version: ${String(record.schema_version)}`)
  if (record.contains === null || typeof record.contains !== 'object' || Array.isArray(record.contains)) throw new Error('contains must be an object')
  if (record.resource === null || typeof record.resource !== 'object' || Array.isArray(record.resource)) throw new Error('resource must be an object')
  const contains = record.contains as Record<string, unknown>
  const resource = record.resource as Record<string, unknown>
  requireExactKeys(contains, 'contains', ['kind', 'summary', 'coverage', 'key_facts', 'available_fields'])
  requireExactKeys(resource, 'resource', ['path', 'format', 'content_sha256'])
  const keyFacts = requireTextList(contains.key_facts, 'contains.key_facts')
  const fields = requireTextList(contains.available_fields, 'contains.available_fields')
  if (new Set(keyFacts).size !== keyFacts.length) throw new Error('contains.key_facts must not contain duplicates')
  if (new Set(fields).size !== fields.length) throw new Error('contains.available_fields must not contain duplicates')
  const path = requireText(resource.path, 'resource.path')
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) throw new Error('resource.path must be an absolute Windows path')
  if (resource.format !== 'json' && resource.format !== 'jsonl' && resource.format !== 'csv') throw new Error('resource.format must be json, jsonl, or csv')
  const contentSha = requireText(resource.content_sha256, 'resource.content_sha256')
  if (!/^[a-f0-9]{64}$/i.test(contentSha)) throw new Error('resource.content_sha256 must be a SHA-256 hex digest')
  return {
    schema_version: 1,
    artifact_id: parseArtifactId(record.artifact_id),
    contains: {
      kind: requireText(contains.kind, 'contains.kind'),
      summary: requireText(contains.summary, 'contains.summary'),
      coverage: requireText(contains.coverage, 'contains.coverage'),
      key_facts: keyFacts,
      available_fields: fields,
    },
    resource: { path, format: resource.format, content_sha256: contentSha },
  }
}
