import { validateSubStepContinuation, type SubStepContinuation } from '../state/sub-state-contract.ts'
import { resolveWorkspaceFile } from '../workspace/workspace-resource.ts'

/** Validates mutable recovery files without turning them into immutable Artifacts. */
export class ContinuationService {
  constructor(private readonly resourceRoot: string) {}

  async validate(value: unknown): Promise<SubStepContinuation> {
    const continuation = validateSubStepContinuation(value)
    return {
      ...continuation,
      working_resources: await Promise.all(continuation.working_resources.map(async resource => ({
        ...resource,
        path: await resolveWorkspaceFile(this.resourceRoot, resource.path, 'Continuation working Resource'),
      }))),
    }
  }
}
