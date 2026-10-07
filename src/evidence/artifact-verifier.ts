import type { ArtifactContains } from './artifact-contract.ts'

export interface ArtifactVerificationInput {
  contains: ArtifactContains
  available_fields: ReadonlySet<string>
}

/** A small replaceable boundary for domain-specific Artifact verification. */
export interface ArtifactVerifier {
  verify(input: ArtifactVerificationInput): void
}

/**
 * MVP verifier: Resource identity, parseability and fields are deterministic.
 * Natural-language key facts remain Agent-authored claims tied to the
 * SubStep's source events; a later verifier may add domain semantics here.
 */
export class StructuredArtifactVerifier implements ArtifactVerifier {
  verify(input: ArtifactVerificationInput): void {
    for (const field of input.contains.available_fields) {
      if (!input.available_fields.has(field)) {
        throw new Error(`Artifact resource does not provide declared field: ${field}`)
      }
    }
  }
}
