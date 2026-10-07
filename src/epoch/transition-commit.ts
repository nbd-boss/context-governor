import type { Artifact } from '../evidence/artifact-contract.ts'
import type { SubState } from '../state/sub-state-contract.ts'
import { TransitionStore, type TransitionFileKind, type TransitionInstallOptions, type TransitionTargetFile } from './transition-store.ts'
import { validateWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/workspace-validator.ts'

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function byId<T extends { [key: string]: string }>(items: readonly T[], key: keyof T): Map<string, T> {
  return new Map(items.map(item => [item[key]!, item]))
}

function changes<T extends { [key: string]: string }>(
  kind: TransitionFileKind,
  directory: string,
  base: readonly T[],
  target: readonly T[],
  key: keyof T,
): TransitionTargetFile[] {
  const prior = byId(base, key)
  const next = byId(target, key)
  for (const id of prior.keys()) if (!next.has(id)) throw new Error(`Boundary commit cannot delete ${kind}: ${id}`)
  return target.flatMap(item => {
    const before = prior.get(item[key]!)
    const baseContent = before === undefined ? undefined : serialize(before)
    const targetContent = serialize(item)
    return baseContent === targetContent ? [] : [{
      kind,
      relative_path: `${directory}/${item[key]}.json`,
      base_content: baseContent,
      target_content: targetContent,
    }]
  })
}

/** Application-level boundary writer: validate snapshots, stage differences, then recoverably install them. */
export class TransitionCommit {
  constructor(private readonly store: TransitionStore) {}

  async initialize(target: WorkspaceSnapshot, options: TransitionInstallOptions = {}): Promise<void> {
    const checked = validateWorkspaceSnapshot(target)
    if (checked.state.revision !== 1) throw new Error('Initial Context State must have revision 1')
    await this.install(undefined, checked, options)
  }

  async commit(base: WorkspaceSnapshot, target: WorkspaceSnapshot, options: TransitionInstallOptions = {}): Promise<void> {
    const checkedBase = validateWorkspaceSnapshot(base)
    const checkedTarget = validateWorkspaceSnapshot(target)
    if (checkedTarget.state.revision !== checkedBase.state.revision + 1) {
      throw new Error('A Context boundary must advance State revision exactly once')
    }
    await this.install(checkedBase, checkedTarget, options)
  }

  async recover(): Promise<boolean> {
    return this.store.recover()
  }

  private async install(base: WorkspaceSnapshot | undefined, target: WorkspaceSnapshot, options: TransitionInstallOptions): Promise<void> {
    const targets: TransitionTargetFile[] = [
      ...changes<Artifact>('artifact', 'artifacts', base?.artifacts ?? [], target.artifacts, 'artifact_id'),
      ...changes<SubState>('sub_state', 'sub_states', base?.sub_states ?? [], target.sub_states, 'sub_state_id'),
      stateChange(base?.state, target.state),
    ]
    await this.store.prepare(base?.state.revision ?? null, target.state.revision, targets)
    await this.store.commitPrepared(options)
  }
}

function stateChange(base: WorkspaceSnapshot['state'] | undefined, target: WorkspaceSnapshot['state']): TransitionTargetFile {
  return {
    kind: 'state',
    relative_path: 'state.json',
    base_content: base === undefined ? undefined : serialize(base),
    target_content: serialize(target),
  }
}
