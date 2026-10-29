import type { Artifact, ArtifactContains, ArtifactResource } from './evidence/artifact-contract.ts'
import type { ArtifactReadResult } from './evidence/artifact-service.ts'
import type { AuditRead, SubStepAuditChange } from './evidence/audit-contract.ts'
import type { EpochAuditRecord } from './evidence/audit-store.ts'
import type { HistoryIndexEntry, RawHistoryEvent } from './evidence/history-index.ts'
import type { RuntimeSubState } from './epoch/context-query.ts'
import type { PressureDecision, PressureSnapshot } from './epoch/pressure-guard.ts'
import type { ResidentContext } from './epoch/resident-context.ts'
import type { PreparedTransitionFile, TransitionManifest, TransitionTargetFile } from './epoch/transition-store.ts'
import type { TaskPlan, TaskPlanStep } from './planning/step-plan.ts'
import type { ContextLifecycle, ContextState, DiscoveredConstraint } from './state/state-contract.ts'
import type {
  ArtifactRef, CompletedSubStep, CriterionEvidence, CurrentSubStep, PlannedSubStep,
  StepCompletionCriterion, SubState, SubStepContinuation, ContinuationWorkingResource,
} from './state/sub-state-contract.ts'
import type { WorkspaceSnapshot } from './workspace/workspace-validator.ts'

/** Meanings only: existing contracts own shapes and validation; tools own operations.
 * Field maps are checked against those contracts, not a second Schema.
 * Keep the full reference here; the resident view below selects only key meanings.
 */
type FieldDescriptions<T> = { readonly [Field in keyof T]-?: string }

const schemaVersion = 'Governor data-format version, not execution progress or a State revision.'
const subStepFields = {
  sub_step_id: 'Governor-allocated identity unique across this Session workspace; its owning Step supplies the execution context.',
  action: 'The planned work for this SubStep. A chosen execution method is replaceable, not an evidenced runtime restriction or an additional acceptance requirement.',
  covers: 'IDs of the owning SubState step_completion_criteria this work supports; planned coverage is not proof of satisfaction.',
} satisfies FieldDescriptions<PlannedSubStep>

/** Single semantic reference for task data, runtime views, audits and recovery records.
 * Contracts own validation; agent-guidance owns actions and decision policies.
 * Service objects, plugin configuration and function/tool inputs stay with their owners;
 * this is a data reference, not a catalogue of every TypeScript implementation type.
 * Documentation examples explain these meanings but do not redefine them.
 */
export const STRUCTURE_DESCRIPTIONS = {
  state: {
    role: 'State is the task-level record of the Mission, plan, constraints and lifecycle. It is authoritative for recorded task status, not independent evidence that Agent-authored business conclusions are true.',
    fields: {
      schema_version: schemaVersion,
      revision: 'Workspace State revision used for optimistic concurrency. Successful mutations advance it; use the latest returned revision rather than an old Epoch snapshot.',
      mission: 'The original user task to preserve; plans and lower-level criteria refine its obligations rather than redefine them.',
      task_plan: 'Task-level acceptance criteria and the ordered Step plan; Step-level detail belongs to SubState.',
      user_constraints: 'Direct human requirements, not Agent guesses, chosen methods or runtime discoveries.',
      next_constraint_number: 'Governor-managed allocator for fresh constraint IDs; not the count of currently effective constraints.',
      discovered_constraints: 'Currently effective, evidence-supported runtime boundaries and their necessary consequences. A chosen workaround is not itself a boundary or the only permitted method.',
      lifecycle: 'Recorded lifecycle of the whole task, separate from a turn ending or an Epoch switching.',
    } satisfies FieldDescriptions<ContextState>,
  },
  task_plan: {
    role: 'The task-wide plan links Steps to final requirements while retaining historical criterion positions.',
    fields: {
      next_step_number: 'Governor-managed allocator for fresh Step IDs; not the number of remaining Steps.',
      completion_criteria: 'Task-wide required final conditions. Existing array positions retain their meaning for historical covers references.',
      superseded_criteria: 'Zero-based indexes of criteria retained for history but no longer effective; superseding does not erase the old entries.',
      steps: 'Ordered Steps with stable identities, recorded progress and links to task-level criteria.',
    } satisfies FieldDescriptions<TaskPlan>,
  },
  step: {
    role: 'One major unit of the task; its detailed execution state lives in the SubState identified by this step_id.',
    fields: {
      step_id: 'Stable Step identity and link to sub_states/<step_id>.json; the label and array position are not its identity.',
      step: 'Work and result this Step is responsible for within the Mission.',
      status: 'pending means not active; in_progress means active; done records completion. The status label does not independently verify the result.',
      covers: 'Zero-based indexes into task_plan.completion_criteria assigned to this Step, not evidence that those criteria are met.',
    } satisfies FieldDescriptions<TaskPlanStep>,
  },
  discovered_constraint: {
    role: 'A confirmed runtime boundary applies only under its evidenced conditions; it neither waives task requirements nor makes a preferred algorithm mandatory.',
    fields: {
      constraint_id: 'Stable identity of an effective boundary, including when explicitly replacing it through a Governor tool.',
      kind: 'Boundary category: retry_safety, external_contract or environment_limit; the category does not establish truth or broaden applicability.',
      condition: 'Observed conditions and scope under which the boundary holds; do not generalize beyond the evidence.',
      required_behavior: 'Behavior necessary because of the evidenced boundary, not an arbitrary selected recovery plan.',
      source_events: 'Original Session event references supporting the boundary; reference existence alone does not prove the interpretation.',
    } satisfies FieldDescriptions<DiscoveredConstraint>,
  },
  lifecycle: {
    role: 'Task completion and execution stopping are different concepts.',
    fields: {
      status: 'active includes ongoing work, final verification and waiting for input; completed records whole-task completion. Stopping a turn or saving a handoff does not complete the task.',
    } satisfies FieldDescriptions<ContextLifecycle>,
  },
  sub_state: {
    role: 'SubState owns one Step\'s detailed criteria and completed/current/pending SubSteps. It refines that Step\'s task-level obligations; its plan and summaries do not replace source evidence.',
    fields: {
      schema_version: schemaVersion,
      step_id: 'The owning State Step; there is no separate persistent sub_state_id.',
      next_sub_step_number: 'Governor-managed allocation watermark used to avoid SubStep ID reuse across the workspace; not the remaining-work count.',
      step_completion_criteria: 'Step-level required outcomes established from parent obligations and evidenced reconnaissance; this is their single persistent source.',
      superseded_criterion_ids: 'IDs of Step criteria retained for history but no longer effective.',
      completed_sub_steps: 'Recorded completed results, evidence links and Artifact references. Historical records remain traceable; later conflicting evidence must not be ignored because a result was recorded here.',
      current_sub_step: 'The active planned SubStep and optional unfinished-work handoff; null means no active SubStep, not automatic Step or task completion.',
      pending_sub_steps: 'Ordered work not yet active; revising it changes the remaining plan, not completed history.',
    } satisfies FieldDescriptions<SubState>,
  },
  step_criterion: {
    role: 'One addressable Step-level outcome; SubSteps refer to it by ID rather than copying its text.',
    fields: {
      criterion_id: 'Governor-allocated identity unique across this Session workspace; the criterion belongs to one Step.',
      criterion: 'The required Step-level outcome, not merely a recommended way of attempting it.',
    } satisfies FieldDescriptions<StepCompletionCriterion>,
  },
  sub_step: {
    role: 'A planned unit of work supporting Step criteria; its presence in a plan does not establish execution or success.',
    fields: subStepFields,
  },
  current_sub_step: {
    role: 'Active work may have useful partial results without being complete.',
    fields: {
      ...subStepFields,
      continuation: 'Latest explicit handoff for this unfinished SubStep, or null when none is recorded. It is separate from completed results.',
    } satisfies FieldDescriptions<CurrentSubStep>,
  },
  completed_sub_step: {
    role: 'A traceable record of a reported completed result, not an independent business verifier.',
    fields: {
      ...subStepFields,
      summary: 'Specific reusable result and its scope, supported by the cited evidence; writing a summary does not make its claims true.',
      criterion_evidence: 'Evidence references for each covered Step criterion; Governor checks reference structure, while the Agent judges what the evidence actually proves.',
      artifact_refs: 'IDs and produced/used relations linking reusable exact Resources; descriptions belong to the Artifact rather than being duplicated here.',
    } satisfies FieldDescriptions<CompletedSubStep>,
  },
  criterion_evidence: {
    role: 'An explicit link between a Step criterion and its original execution evidence.',
    fields: {
      criterion_id: 'The covered Step criterion this evidence is intended to support.',
      source_events: 'Session-local event-N references; inspect what the original observations prove, not merely that an event or successful call exists.',
    } satisfies FieldDescriptions<CriterionEvidence>,
  },
  artifact_ref: {
    role: 'A relationship to an Artifact, not a copy of its metadata or contents.',
    fields: {
      artifact_id: 'The referenced Artifact identity.',
      relation: 'produced identifies the producing completed SubStep; used records reuse by another completed SubStep.',
    } satisfies FieldDescriptions<ArtifactRef>,
  },
  continuation: {
    role: 'Continuation preserves unfinished progress, uncertainty, working-file references and the next action. It can preserve reconnaissance findings; it proves neither completion nor the truth of every saved claim.',
    fields: {
      progress: 'Confirmed progress and coverage, explicitly distinguished from uncertainties, failures and unresolved outcomes.',
      working_resources: 'Real workspace files needed to resume, with absolute paths and content descriptions; references do not make mutable files immutable Artifacts.',
      resume_from: 'Specific next work or external input needed to resume, consistent with confirmed progress and effective constraints.',
    } satisfies FieldDescriptions<SubStepContinuation>,
  },
  working_resource: {
    role: 'A real working file referenced by unfinished work; it may evolve as that work proceeds.',
    fields: {
      path: 'Absolute workspace path to the actual file; a description alone does not preserve exact data.',
      contains: 'What the file currently contains and its coverage, including incompleteness relevant to resuming work.',
    } satisfies FieldDescriptions<ContinuationWorkingResource>,
  },
  artifact: {
    role: 'Artifact describes one immutable Resource for precise reuse. Registration checks file identity, parseability and declared fields, not business truth, source fidelity or completion of an external action.',
    fields: {
      schema_version: schemaVersion,
      artifact_id: 'Stable identity used by SubStep references and Artifact reads.',
      contains: 'The single authoritative Artifact metadata description, not a second copy of the exact Resource.',
      resource: 'The exact immutable file and its integrity identity; changed contents require a new file and Artifact.',
    } satisfies FieldDescriptions<Artifact>,
  },
  artifact_contains: {
    role: 'Compact navigation metadata helps decide whether existing facts suffice or exact Resource contents are needed.',
    fields: {
      kind: 'Agent-assigned content category, not a correctness or completion status.',
      summary: 'Concise description of the Resource, not its complete contents.',
      coverage: 'Objects, scope and boundaries actually represented, including relevant omissions.',
      key_facts: 'Specific, source-supported facts reusable without opening the Resource; these remain Agent-authored claims rather than independently verified business conclusions.',
      available_fields: 'Data fields available for exact reuse; their existence does not prove record completeness or correct values.',
    } satisfies FieldDescriptions<ArtifactContains>,
  },
  artifact_resource: {
    role: 'The exact data remains in the Resource; metadata and hashes do not substitute for its provenance.',
    fields: {
      path: 'Absolute path to the registered workspace Resource.',
      format: 'Parser format: json, jsonl or csv.',
      content_sha256: 'Digest of the registered bytes used to detect later changes, not a proof that the data agrees with the original source.',
    } satisfies FieldDescriptions<ArtifactResource>,
  },
  artifact_catalog: {
    role: 'A read-only runtime projection of referenced Artifacts\' IDs and contains metadata, deduplicated within a SubState view. It is derived from Artifact records, not another persistent authority.',
    fields: {
      artifact_id: 'Referenced Artifact identity; exact Resource data stays in the Artifact layer.',
      contains: 'The referenced Artifact\'s metadata projected for navigation, not a separately maintained description.',
    } satisfies FieldDescriptions<Pick<Artifact, 'artifact_id' | 'contains'>>,
  },
  history: {
    role: 'History preserves original execution events, including failures, guesses and later corrections. An event reference locates evidence; it does not certify a claim, and a stored preview may omit externally stored result details.',
    fields: {
      id: 'Session-local event-N identifier locating the original event sequence.',
      kind: 'Event category: user_message, assistant_message, tool_call or tool_result; it is navigation, not a relevance or truth assessment.',
    } satisfies FieldDescriptions<HistoryIndexEntry>,
  },
  raw_history_event: {
    role: 'The minimal DSH event envelope used for indexing. DSH owns the full event body and externalized result storage; Governor does not define another raw History format.',
    fields: {
      seq: 'Original sequence number within the Session, used to construct event-N references.',
      type: 'DSH event type; the index includes only its supported user/message, assistant/message, tool/call and tool/result categories.',
    } satisfies FieldDescriptions<RawHistoryEvent>,
  },
  artifact_read_result: {
    role: 'Integrity-checked access to an existing Resource, not a new verification of business claims.',
    fields: {
      status: 'ready means the Resource is readable and its bytes match the registered hash; stale means it is missing or changed and trusted content is not returned.',
      artifact: 'The existing Artifact metadata associated with this read.',
      content: 'Exact Resource content when ready: parsed JSON/JSONL or CSV text. Availability does not establish source fidelity or semantic correctness.',
    } satisfies FieldDescriptions<ArtifactReadResult>,
  },
  switch_note: {
    role: 'Governor carries reason into the next Epoch as switch_note and records it in the Epoch audit. This auxiliary note is not a state update, a completion claim, or verified evidence; it does not overwrite or merge into State, SubState, or Continuation.',
  },
  information_placement: {
    role: 'Put confirmed runtime boundaries in discovered_constraints and completed task results in completed SubStep summaries or Artifacts as appropriate. Reusable facts from unfinished work, including reconnaissance findings, belong in the current SubStep\'s Continuation under its real-working-file rules; the SubStep need not be complete to preserve these facts. Keep temporary failures, hypotheses, candidate recovery paths, and unresolved outcomes in current History or an existing handoff as explicitly unconfirmed information.',
  },
  workspace_snapshot: {
    role: 'A combined view used to validate cross-file relationships and commit changes, not an extra persistent copy of the task.',
    fields: {
      state: 'The task-level State record.',
      sub_states: 'The Step-owned SubState records, linked to State by step_id.',
      artifacts: 'The Artifact metadata records referenced by completed SubSteps.',
    } satisfies FieldDescriptions<WorkspaceSnapshot>,
  },
  runtime_sub_state: {
    role: 'The read-only SubState navigation view adds an Artifact catalogue; it does not create another durable SubState.',
    fields: {
      artifact_catalog: 'Referenced Artifact metadata projected once per view; persisted artifact_refs retain only ID and relation.',
    } satisfies FieldDescriptions<Omit<RuntimeSubState, keyof SubState>>,
  },
  resident_context: {
    role: 'The built Epoch baseline and its serialization are runtime views, not additional persistent State records.',
    fields: {
      payload: 'The structured context_governor baseline assembled from current durable data and applicable Guidance.',
      text: 'JSON serialization of that same payload for DSH message construction, not separately authored information.',
    } satisfies FieldDescriptions<ResidentContext>,
  },
  context_payload: {
    role: 'The context_governor message combines an Epoch-start snapshot, derived descriptions and policies. Subsequent successful tools return newer durable revisions; this initial message is not rewritten in place.',
    fields: {
      instruction: 'How to interpret and use this Epoch baseline and applicable recovery instructions.',
      structure_descriptions: 'A compact selection from this semantic reference, not a separately maintained field manual.',
      session_id: 'The DSH Session owning this baseline and its workspace.',
      state: 'The State snapshot used to start this Epoch.',
      current_sub_state: 'The active Step\'s runtime SubState, or null when none exists; other Steps are available through navigation.',
      switch_note: 'Optional auxiliary note carried from the latest Context switch; its semantics are defined by switch_note above.',
      retrieval_policy: 'The prior-work lookup policy defined in agent-guidance; it does not perform retrieval by itself.',
      exact_data_transfer_policy: 'The exact-data handling policy defined in agent-guidance; it does not itself copy or validate business data.',
      decision_checks: 'Named decision phases from agent-guidance for the Agent to apply; not automatic semantic validators.',
    },
  },
  decision_phase: {
    role: 'A model instruction organized by applicability and named checks; Governor does not automatically execute its business reasoning.',
    fields: {
      when: 'Situations in which the Agent should apply this phase, not a registered runtime event trigger.',
      checks: 'Named obligations the Agent evaluates when applicable, not independently executed validators.',
      if_unverified: 'What to do when the required evidence or outcome remains unresolved.',
    },
  },
  epoch_audit: {
    role: 'A record of Governor management activity within one Epoch. It supports diagnosis and tracing, not independent business acceptance or task progress.',
    fields: {
      version: 'Audit record format version, separate from State revision and task progress.',
      epoch: 'Sequential Context window number within this Session audit.',
      session_id: 'The Session whose management activity is recorded.',
      baseline_event: 'History reference for the Epoch baseline message.',
      resident_tokens: 'Estimated baseline token usage at Epoch start, not the entire subsequent Context size.',
      reads: 'Governor-recorded navigation reads; this does not claim to capture every possible Agent file or system read.',
      switch: 'Optional boundary record when the Epoch ends through a Context switch.',
      completion: 'Optional boundary record when whole-task completion closes the Epoch; recording it is not independent business verification.',
    } satisfies FieldDescriptions<EpochAuditRecord>,
  },
  audit_boundary: {
    role: 'Metadata for a switch or completion boundary; it describes the management event rather than another task-state authority.',
    fields: {
      reason: 'Agent-provided explanation recorded for the boundary, not a State or Continuation mutation.',
      end_event: 'History reference marking the boundary.',
      state_changed: 'Whether State revision changed relative to the Epoch baseline, not whether a business outcome was independently verified.',
      sub_step_changes: 'Recorded SubStep management changes associated with the boundary; not a replacement for SubState history.',
      pressure: 'Optional token-pressure snapshot associated with the boundary.',
    } satisfies FieldDescriptions<NonNullable<EpochAuditRecord['switch']>>,
  },
  audit_read: {
    role: 'One recorded Governor navigation request.',
    fields: {
      kind: 'Navigation target category: sub_state, artifact, event or event_range.',
      target: 'Identifier or event range requested; the entry does not prove the retrieved content is true.',
    } satisfies FieldDescriptions<AuditRead>,
  },
  sub_step_audit_change: {
    role: 'A small management-change record retained for audit, not the full completed result.',
    fields: {
      operation: 'Recorded creation or update of a SubStep.',
      step: 'The owning Step description used in the audit.',
      sub_step_id: 'Identity of the affected SubStep.',
      sub_step: 'The affected SubStep action description.',
    } satisfies FieldDescriptions<SubStepAuditChange>,
  },
  pressure_snapshot: {
    role: 'Runtime inputs for estimating whether the next request reaches the configured Context safety line.',
    fields: {
      contextWindow: 'Model Context capacity supplied by DSH.',
      currentTokens: 'Current Context token estimate supplied by the runtime.',
      pendingMessageTokens: 'Estimated tokens for the pending message not yet included in currentTokens.',
    } satisfies FieldDescriptions<PressureSnapshot>,
  },
  pressure_decision: {
    role: 'A derived Context-pressure decision, not a task-completion or business-progress decision.',
    fields: {
      thresholdTokens: 'Safety-line token count calculated from Context capacity and the configured switch ratio.',
      projectedTokens: 'Estimated current plus pending-message token usage.',
      shouldRemind: 'Whether projected usage reaches the safety line and requires the closing/switch handoff policy.',
    } satisfies FieldDescriptions<PressureDecision>,
  },
  audit_pressure: {
    role: 'The token-pressure values retained at an audited boundary.',
    fields: {
      currentTokens: 'Runtime-measured Context token usage at the boundary, not the pending-request projection.',
      contextWindow: 'Model Context capacity at that boundary.',
      thresholdTokens: 'The configured safety-line token count.',
    } satisfies FieldDescriptions<NonNullable<NonNullable<EpochAuditRecord['switch']>['pressure']>>,
  },
  transition_manifest: {
    role: 'A recoverable multi-file commit journal. It owns installation recovery metadata, not task facts or a second task snapshot.',
    fields: {
      schema_version: schemaVersion,
      base_state_revision: 'Expected pre-commit State revision; null for initialization with no previous State.',
      target_state_revision: 'State revision the transaction will install.',
      files: 'Prepared file entries whose staged contents and hashes define the commit target.',
    } satisfies FieldDescriptions<TransitionManifest>,
  },
  prepared_transition_file: {
    role: 'One prepared file in the recovery journal; hashes identify transaction bytes rather than business truth.',
    fields: {
      kind: 'The durable file category: artifact, sub_state or state.',
      relative_path: 'Destination path relative to this Session workspace.',
      base_sha256: 'Expected previous file hash, or null when the file did not exist.',
      target_sha256: 'Hash of the bytes the transaction will install.',
      staged_path: 'Prepared-file path relative to the transition directory.',
    } satisfies FieldDescriptions<PreparedTransitionFile>,
  },
  transition_target_file: {
    role: 'An in-memory target supplied to transaction preparation; it is not another long-lived state file.',
    fields: {
      kind: 'The durable file category to install.',
      relative_path: 'Destination path relative to the Session workspace.',
      base_content: 'Expected previous serialized content, or undefined if the file is new.',
      target_content: 'Serialized content to stage and install.',
    } satisfies FieldDescriptions<TransitionTargetFile>,
  },
} as const

/** Small Agent-facing view; do not inject the full field reference every Epoch.
 * All selected meanings come from the reference above, with no parallel wording.
 */
export const RESIDENT_STRUCTURE_DESCRIPTIONS = {
  state: STRUCTURE_DESCRIPTIONS.state.role,
  sub_state: STRUCTURE_DESCRIPTIONS.sub_state.role,
  planned_action: STRUCTURE_DESCRIPTIONS.sub_step.fields.action,
  user_constraints: STRUCTURE_DESCRIPTIONS.state.fields.user_constraints,
  discovered_constraints: STRUCTURE_DESCRIPTIONS.state.fields.discovered_constraints,
  continuation: STRUCTURE_DESCRIPTIONS.continuation.role,
  artifact: STRUCTURE_DESCRIPTIONS.artifact.role,
  artifact_catalog: STRUCTURE_DESCRIPTIONS.artifact_catalog.role,
  history: STRUCTURE_DESCRIPTIONS.history.role,
} as const
