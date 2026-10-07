import { requireTextList } from '../contract-utils.ts'

/** Validate one immutable parent-level acceptance-criteria list. */
export function validatePlanningCriteria(value: unknown, field: string): string[] {
  const criteria = requireTextList(value, field)
  if (criteria.length === 0) throw new Error(`${field} must be a non-empty array`)
  if (new Set(criteria).size !== criteria.length) throw new Error(`${field} must not contain duplicates`)
  return criteria
}

/** Validate indexes from one child planning item into its parent criteria. */
export function validateIndexedCovers(value: unknown, criterionCount: number, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`)
  const seen = new Set<number>()
  return value.map((candidate, index) => {
    if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate >= criterionCount) {
      throw new Error(`${field}[${String(index)}] must be a valid completion-criteria index`)
    }
    const cover = candidate as number
    if (seen.has(cover)) throw new Error(`${field} contains duplicate criterion index: ${String(cover)}`)
    seen.add(cover)
    return cover
  })
}

/** Ensure the complete child plan covers every immutable parent criterion. */
export function requireCompleteCoverage(
  criteria: readonly string[],
  coversByItem: readonly (readonly number[])[],
  criteriaField: string,
): void {
  const covered = new Set(coversByItem.flat())
  for (let index = 0; index < criteria.length; index += 1) {
    if (!covered.has(index)) throw new Error(`${criteriaField}[${String(index)}] is not covered by any planning item`)
  }
}
