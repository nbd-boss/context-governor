import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import { AuditRecorder } from '../evidence/audit-recorder.ts'
import { AuditStore } from '../evidence/audit-store.ts'
import { ArtifactService } from '../evidence/artifact-service.ts'
import { ArtifactStore } from '../evidence/artifact-store.ts'
import { SubStateStore } from '../state/sub-state-store.ts'
import { ContextStateStore } from '../state/state-store.ts'
import { TransitionCommit } from '../epoch/transition-commit.ts'
import { TransitionStore } from '../epoch/transition-store.ts'
import { ContinuationService } from '../epoch/continuation-service.ts'

export interface SessionWorkspace {
  state: ContextStateStore
  sub_states: SubStateStore
  artifacts: ArtifactStore
  artifact_service: ArtifactService
  continuation_service: ContinuationService
  transition: TransitionCommit
  audits: AuditRecorder
  recover(): Promise<boolean>
}

/**
 * The only component that maps a DSH Session identity to files on disk.
 * Feature modules receive a workspace, never a shared root path.
 */
export class SessionWorkspaceProvider {
  private readonly workspaces = new Map<string, SessionWorkspace>()

  constructor(
    private readonly rootDirectory: string,
    private readonly artifactResourceRoot = dirname(rootDirectory),
  ) {}

  forSession(sessionId: string): SessionWorkspace {
    const cached = this.workspaces.get(sessionId)
    if (cached !== undefined) return cached
    const workspaceRoot = join(this.rootDirectory, 'sessions', safeDirectoryName(sessionId))
    const state = new ContextStateStore(join(workspaceRoot, 'state.json'))
    const workspace: SessionWorkspace = {
      state,
      sub_states: new SubStateStore(join(workspaceRoot, 'sub_states')),
      artifacts: new ArtifactStore(join(workspaceRoot, 'artifacts')),
      artifact_service: new ArtifactService(this.artifactResourceRoot),
      continuation_service: new ContinuationService(this.artifactResourceRoot),
      transition: new TransitionCommit(new TransitionStore(workspaceRoot)),
      audits: new AuditRecorder(new AuditStore(join(workspaceRoot, 'audit'))),
      async recover(): Promise<boolean> {
        const recovered = await this.transition.recover()
        if (recovered) this.state.invalidate()
        return recovered
      },
    }
    this.workspaces.set(sessionId, workspace)
    return workspace
  }
}

function safeDirectoryName(sessionId: string): string {
  if (/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) return sessionId
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`
}
