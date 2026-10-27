/** Shared model instruction, not an automatic runtime validator. */
export const DECISION_CHECK_USAGE = 'When a decision phase applies, evaluate every applicable named check; satisfying one check does not satisfy the whole phase. Skip inapplicable checks without adding unrelated work.'

/** One authority for preserving parent obligations in planning and completion. */
export const PARENT_OUTCOME_REQUIREMENTS = [
  'Keep lower-level criteria and verification reports faithful to the required parent outcomes. Lower-level criteria refine, not redefine, parent obligations: preserve required deliverables, scope, and conditions when creating or revising them, rather than deriving requirements from actual or achievable results. Performing checks, generating a report, or recording a known limitation does not fulfill a failed or unverified required outcome.',
  'Completing investigation or exception reporting proves only that investigation or report, not a separate required result. An instruction to report failures, missing resources, or limitations is a communication duty, not permission to omit a required deliverable. Treat exception handling as an alternative completion condition only when the authoritative requirement explicitly permits that alternative through omission, substitution, or partial delivery.',
  'Compare relevant known failures and unresolved outcomes with the work being completed. Runtime constraints explain obstacles, not exemptions: do not weaken acceptance criteria or mark affected work complete merely because the obstacle is documented.',
  'If competing interpretations change whether the task is complete and authoritative evidence does not resolve the ambiguity, retain the affected requirement as unresolved, report the ambiguity, and seek user clarification when needed; do not choose an interpretation merely because it makes the current result pass.',
] as const

/** Shared decision checks; names provide navigation, not separate rule copies. */
export const DECISION_CHECKS = {
  before_scope_or_external_change: {
    when: 'Before choosing an execution or recovery action, setting acceptance criteria, claiming complete coverage, narrowing scope, excluding candidates, matching records across systems, or changing external data from an inference',
    checks: {
      scope_boundary: [
        'Use evidence sufficient to establish each specific conclusion used for task scope, acceptance criteria, execution, recovery, or completion; merely having related observations is not enough.',
        'For scope decisions, identify the full candidate set, proposed boundary, and direct supporting evidence; consistency among observed records alone cannot establish that nothing was omitted.',
        'Establish the object and scope of each condition before applying it. Do not extend a scoped condition to a broader domain or add exclusion conditions from contextual labels or related wording without direct authoritative support; a stricter interpretation is not automatically the correct one.',
        'For any input that changes task scope or a computed result, establish its source, assigned purpose, and governing meaning. Authority for one purpose does not establish authority for another: material provided for presentation or communication does not define eligibility, exclusions, or acceptance criteria unless the requirement explicitly assigns it that role. Descriptive wording, examples, field existence, or agreement with expected labels do not authorize a new condition.',
        'When missing or conflicting evidence leaves such an input ambiguous in a way that affects the result, resolve that ambiguity before adopting the input as a confirmed basis for execution or completion. Reuse already sufficient evidence without unnecessary re-querying.',
      ],
      evidence_quality: [
        'Before promoting a conclusion to trusted State, a completion criterion, or a reusable result, distinguish what was requested or expected from what was actually observed, and identify any unverified inference between the observation and conclusion.',
        'A successful check establishes only the tested scope and conditions, not completeness or capability under untested conditions.',
        'Saving or repeating a conclusion in a summary, Artifact, or criterion does not provide independent evidence for it.',
      ],
      identity_and_exclusion: [
        'Direct evidence must establish the required relationship or exclusion itself.',
        'Correlation, timing, ordering, naming similarity, equal identifier values, or a plausible narrative are not evidence unless an explicit specification or current tool result defines them as the governing rule.',
        'A cross-system identity mapping requires direct evidence and no conflicting identity attributes.',
      ],
      deterministic_selection: [
        'When a system can express the evidenced decision as a deterministic query, filter, or join, use that operation and retain its result rather than relying on a model-selected subset.',
        'A returned subset does not by itself establish that its selection rule is required by the task.',
      ],
      known_constraints: [
        'Before retrying a path or resuming exploration, compare the proposed operation with relevant State.discovered_constraints according to their condition and required_behavior; do not repeat a ruled-out attempt under unchanged conditions.',
        'Reconsider a restriction only when evidence shows that its condition no longer applies; a new Context Epoch alone is not such evidence.',
      ],
      recovery_effect: [
        'Select a recovery action only when its intended effect is explicitly supported by the available capability or direct evidence; do not assume undeclared side effects or treat an unverified recovery as successful. A substitute must achieve the required business effect, not merely produce similar-looking records or outputs.',
      ],
    },
    if_unverified: 'Keep conclusions without sufficient evidence as explicitly unverified hypotheses, usable to guide investigation but not as confirmed facts, scope boundaries, acceptance criteria, or completion claims. When no direct evidence supports excluding a candidate or applying an identity mapping, preserve the candidate in scope and leave the relationship unresolved. Do not use the inference to calculate, persist a trusted conclusion, mark work complete, update, overwrite, or delete an existing record.',
  },
  after_reconnaissance: {
    when: 'After learning relevant external schema, state semantics, existing records, or runtime limitations',
    checks: {
      state_semantics: [
        'Use only fields whose meaning is directly established by the user, specification, system documentation, tool result, or existing record; do not invent state semantics.',
      ],
      authoritative_outcome: [
        'For each external action, inspect the target system schema, documentation, tool results, and existing records for fields directly evidenced to represent that action\'s status or time.',
        'When such fields exist, name their required final values in the completion criterion and verify them by read-back after the action.',
        'If reconnaissance establishes a persistent record of a required external action, the affected Step criteria and later execution SubSteps must name the required state transition and authoritative read-back, including action-status or action-time fields whose meaning is established.',
        'Compare Mission-required actions with directly evidenced authoritative outcomes; carry any missing post-action state transition, final value, and read-back into affected pending work, even if the initial criteria omitted them.',
      ],
      change_boundary: [
        'Before changing external data, identify the authorized target records and fields using evidenced identities, and preserve existing data outside that change boundary.',
        'Carry the boundary and proportionate preservation checks into affected criteria and pending work; success for the target records alone does not establish that unrelated data remained intact.',
      ],
      constraint_recording: [
        'When direct evidence confirms a runtime restriction that will govern later work, promptly call record_discovered_constraint with its condition, required_behavior, and source_events identifying the supporting original events before choosing another path or retrying; do not leave it only in a Continuation or work note.',
        'Before saving a handoff, check for confirmed restrictions still recorded only in notes or current History and record those not already covered by State.discovered_constraints; do not duplicate existing constraints.',
        'Record only the evidenced scope of a restriction.',
        'A single failed or timed-out request does not establish a permanent limitation or prove whether the operation completed.',
        'Put confirmed runtime boundaries in discovered_constraints, ordinary task facts and completed results in SubState summaries or Artifacts as appropriate, and temporary failures, hypotheses, candidate recovery paths, and unresolved outcomes in current History or an existing handoff instead.',
      ],
      constraint_replacement: [
        'Before recording constraints, compare their applicability and required behavior with the current effective constraints and each other in the same submission.',
        'Different conditions may coexist; reuse an existing equivalent boundary rather than duplicating it.',
        'When sufficient new evidence overturns an active constraint, identify its constraint_id in replaces and state the supported replacement; otherwise leave the conflict unresolved instead of asserting opposing rules as simultaneously confirmed.',
        'replaces: [] adds an independent boundary.',
        'Governor executes explicit replacements atomically but does not infer semantic conflicts.',
      ],
      constraint_handoff: [
        'At a Context switch, submit confirmed restrictions to add or replace through switch_context.new_discovered_constraints, or [] when none remain.',
        'This handoff persists them before the next Epoch, including in closing mode; do not defer recording to the next Epoch or duplicate them in a Continuation.',
      ],
    },
    if_unverified: 'Keep unsupported state assumptions out of the plan; leave affected pending work provisional until the evidence is available.',
  },
  before_completion: {
    when: 'Before completing a SubStep, Step, or task',
    checks: {
      criteria_coverage: [
        'Before choosing a progress branch, determine whether the current unit is actually complete. For a SubStep, verify its covered criteria; for a Step, verify its promised result and the effective task_plan.completion_criteria entries referenced by its covers. Keep Mission outcomes outside this Step\'s responsibility assigned to later work. Satisfying all lower-level criteria, having no pending SubSteps, or having no executable action does not by itself establish Step completion.',
        ...PARENT_OUTCOME_REQUIREMENTS,
        'Before completing the task, independently compare the Mission, directly evidenced authoritative outcomes, and actual evidence; a missing criterion does not waive a required outcome.',
        'Apply context_governor.decision_checks.before_scope_or_external_change to conclusions used as completion evidence.',
      ],
      source_correctness: [
        'Verify input coverage and the decision or calculation against authoritative requirements and source evidence separately from checking that an output was persisted. For selection-based work, establish the rule and source coverage before using the selected set as the complete target; processing every selected item does not establish that all required items were selected.',
        'A program or tool output derived from model-supplied inputs establishes only the result under those inputs, not their authority or correctness; trace material inputs back to their original evidence rather than treating an echoed or computed value as independent support.',
        'A read-back matching a computed value proves write consistency, not that the input scope or computation was correct; criteria or summaries copied from that value are not an independent check.',
        'For reconstructed exact inputs, apply context_governor.exact_data_transfer_policy before claiming source fidelity or completing dependent work.',
        'Reuse sufficient prior scope evidence when it remains applicable, without re-querying solely to repeat this check. If scope or execution remains unverified, keep the dependent completion claim unverified; for complete_task, report unverified rather than met in task_criteria_check.',
      ],
      tool_outcome: [
        'Inspect actual tool-result content for failure, partial success, or an unresolved outcome even when the call returns normally or reports no tool-level error.',
        'An attempted action is not a successful outcome.',
        'Creating, importing, or updating a record that describes an action proves that record changed, not that the action occurred. Use such a record as evidence of the action only when authoritative operation semantics establish that effect or direct outcome evidence confirms it.',
        'Resolve contradictory evidence through authoritative results before claiming success; do not convert an error into a success summary, Artifact fact, or completion claim.',
      ],
      authoritative_state: [
        'Before considering a Step that causes an external action complete, determine whether an authoritative persistent system records that action\'s outcome.',
        'When direct evidence establishes such a record, plan the post-action update or reconciliation and its read-back as part of the same Step; a successful action call, output Artifact, or observation in another system is not sufficient while the authoritative persistent state remains inconsistent.',
        'Verify any directly specified preservation condition as well, and apply the change-boundary checks in context_governor.decision_checks.after_reconnaissance.',
      ],
    },
    if_unverified: 'Keep an unverified claimed outcome in progress, preserving confirmed partial progress and unresolved failures in History or an existing handoff rather than claiming completion. If a Mission-required outcome is missing from the plan, assign it to later work or reconcile it before task completion. When blocked, explain the partial progress, missing input, and recovery condition to the user; if a current SubStep exists, persist that handoff with record_continuation operation=wait_for_input to end the turn while lifecycle.status remains active. Without a current SubStep, end the reply with a truthful partial-progress and blocker report while lifecycle.status remains active; do not invent a plan or file merely to stop. complete_task is permitted only after successful completion, not required at the end of every attempt; do not rewrite requirements to satisfy its preconditions.',
  },
} as const

export function formatDecisionCheck(name: keyof typeof DECISION_CHECKS): string {
  const rule = DECISION_CHECKS[name]
  const checks = Object.entries(rule.checks)
    .map(([check, requirements]) => `${check}:\n${formatGuidance(requirements)}`)
  return [rule.when, DECISION_CHECK_USAGE, ...checks, `If unverified: ${rule.if_unverified}`].join('\n\n')
}

/** Keep list boundaries, including an already formatted shared list. */
function formatGuidance(items: readonly string[]): string {
  return items.map(item => item.startsWith('- ') ? item : `- ${item}`).join('\n')
}

/** One execution policy for moving exact source data without using the model as a data copier. */
export const EXACT_DATA_TRANSFER_GUIDANCE = formatGuidance([
  'When later calculation, filtering, or external writing depends on exact source data, prefer a program, file read, database query, export, or API path that directly reads, transforms, and writes the data, using supported batch operations; use the model only to choose scope, fields, and transformation rules.',
  'Source values re-entered by the model as code literals or write-tool arguments are model transcription, not direct transfer, even when a program saves or computes from them. Shortening or encoding those values does not change this.',
  'Internal processing may use codes, aliases, or other compact representations, but retain a reliable mapping to source values. Final deliverables must use the representation explicitly required by the task; absent an explicit transformation requirement, preserve source names and identifiers. Before publishing, verify that final values correspond to the source in the required representation; agreement between outputs alone does not establish this.',
  'When planning work that reconstructs exact inputs, make source correspondence explicit in the affected Step completion criteria for the fields and relationships needed downstream. Order the SubSteps so that source verification precedes dependent use; do not add a new task-level deliverable merely for this internal check.',
  'When direct transfer is unavailable and data must be reconstructed from bounded source results, first identify complete source coverage and a reconstruction plan. Preserve enough source boundaries to detect omissions, overlaps, reordered records, or changed field relationships. Verify each reconstructed portion against its source before treating it as verified input for dependent calculation, filtering, or external writes.',
  'A reconstructed result that parses, has a plausible count, or satisfies internal statistics is not by itself evidence that it corresponds completely and accurately to its source. Match reconstructed records to source records by stable identity or source position and compare the required field values and relationships, including entity roles and relationship direction, as well as coverage and partition boundaries. Recomputing from the same reconstructed input or reading back a downstream write does not establish source fidelity.',
  'Use the existing completion summary and source_events to identify the actual source-comparison scope and supporting evidence. A spot check supports only the sampled records; do not expand sampling, count checks, or internal consistency into a claim that every required source value was verified. Reuse sufficient applicable comparisons without repeating them solely for completion bookkeeping.',
  'If available checks cannot establish the required fidelity, keep the result explicitly incomplete or unverified; do not treat it as verified exact input for dependent calculation, filtering, or external writes. Model transcription remains a last resort and must be treated as reconstructed data rather than a direct copy.',
])

/** One source for the result-first method shared by both planning levels. */
export const PLANNING_CORE_GUIDANCE = formatGuidance([
  ...PARENT_OUTCOME_REQUIREMENTS,
  'Before planning children, normalize every parent completion criterion into one observable condition at this planning level. Split a criterion that combines distinct outputs, files, or conditions that different children would establish.',
  'Work result-first from the complete parent acceptance criteria: identify independently verifiable results, then give each result its conceptual inputs and one main unit of work.',
  'Multiple inputs belong together only when they jointly produce the same result and share one verification boundary.',
  'Before submitting, split any result that actually contains two outputs that could be saved, verified, or reused independently.',
  'Create a separate child for investigation or preparation only when it produces an independently verifiable result needed later and legitimately advances a parent criterion. Otherwise perform the preparation inside the child that produces the required result. Never invent a completion criterion merely to justify a child.',
  'List a criterion in a child covers only when that child\'s completed result independently proves the criterion. covers never means partial contribution; if multiple children must jointly establish a criterion, split that parent criterion first.',
  'A planning level may claim only results established at that level: a write stage must not claim validation delegated to a later stage.',
  'Use covers to ensure every parent criterion is covered and remove unrelated or duplicate work.',
  'Before adopting a scope or identity rule in a plan, apply context_governor.decision_checks.before_scope_or_external_change.',
])

/** One source for translating the user task into its sole persisted task-level acceptance criteria. */
export const TASK_COMPLETION_CRITERIA_GUIDANCE = formatGuidance([
  'Before planning Steps, derive the complete task_plan completion_criteria directly from the Mission while respecting direct user constraints.',
  'Each criterion must state a user-observable final condition, not an implementation action or a claim that an internal step occurred.',
  'Capture every independent required deliverable, required coverage, decision rule that affects the result, and required output condition such as format, ordering, or compatibility.',
  'Preserve the Mission\'s required scope and force: do not weaken all, every, each, only, must, complete, or exact requirements into related, target, needed, or partial work.',
  'When a Mission requires external actions and affects a persistent business system, derive a final completion criterion requiring authoritative persistent state to reflect every required action outcome and any directly specified preservation condition. Name concrete status or time fields only after their meaning is directly established.',
])

/** One source for model-visible top-level Step planning rules. */
export const STEP_PLANNING_GUIDANCE = formatGuidance([
  'Plan the whole Mission as ordered major stages or milestones. A Step may span multiple Context Epochs and may contain several related reusable results, but completing it must materially advance the overall task stage.',
  'Steps implement the fixed task completion criteria; they must not reinterpret or narrow required deliverables, coverage, or decision rules.',
  'When an activated Step depends on unresolved external evidence that affects its acceptance criteria, inspect only what is needed before calling plan_current_step. If existing authoritative evidence is enough, plan immediately. Use revise_step for a pending top-level Step and revise_substep for a pending SubStep. If a criterion itself changes, revise it with affected work through the criteria replan tool.',
  'Stop pre-planning reconnaissance once evidence is sufficient to establish criteria and a feasible next action; do not wait to exhaust alternative routes or finish the Step\'s main work before planning.',
  'Do not create a Step for one tool call, one file read, one search, one implementation detail, or an arbitrary fixed item batch.',
  'For each Step, inputs and result are planning-only explanations; Governor persists only step, status, and covers.',
])

/** One source for model-visible SubStep-specific planning rules. */
export const SUB_STEP_PLANNING_GUIDANCE = formatGuidance([
  'Before generating step_completion_criteria, read the active Step description and the effective State.task_plan.completion_criteria entries referenced by that Step\'s covers. Derive observable criteria from those obligations, the authoritative user request, constraints, and referenced specifications, applying the shared parent-outcome requirements rather than selecting only currently achievable work.',
  'A genuinely reusable interim result may be a Step-level criterion when it is needed to finish the Step; task_plan completion_criteria remain the user-facing final conditions and must not be expanded merely for internal preparation.',
  'When planning or revising SubSteps after relevant reconnaissance, apply context_governor.decision_checks.after_reconnaissance to the Step criteria and affected pending work.',
  'For reconstructed exact inputs, apply context_governor.exact_data_transfer_policy when setting Step criteria and ordering SubSteps.',
  'When the active current SubStep is independently verifiable reconnaissance, inspect only the evidence needed to resolve the external contract. Before completing it, use revise_substep if provisional pending items need an evidence-based execution plan; reconnaissance itself must not claim that an external action or write is complete.',
  'When reconnaissance directly establishes a safe execution boundary, such as a source page boundary, result-size limit, rate limit, or other tool constraint, use a bounded operation to confirm a feasible path, then advance the required result rather than exploring every alternative. Treat the boundary as established until an operation fails, direct evidence contradicts it, or relevant conditions change; do not keep re-investigating it merely to regain confidence.',
  'When a SubStep needs multiple bounded operations, materialize useful partial progress in real working files and save it with record_continuation before it would otherwise need to be reconstructed. Keep the SubStep active until its covered criteria are met; a batch is not automatically a new SubStep or an Artifact.',
  'Each submitted item is one candidate SubStep with one independently verifiable and reusable result that can normally be advanced within one Context Epoch.',
  'Write each SubStep action as an observable result, not merely a tool operation. inputs and result are planning-only explanations; Governor persists only action and covers.',
  'Never create a SubStep for one tool call, one file read, one search, or unverified partial work.',
])

/** One source for deciding whether an exact file belongs in the Artifact layer. */
export const ARTIFACT_SELECTION_GUIDANCE = formatGuidance([
  'Register an Artifact only when a verified structured file contains exact details that later work must reuse across Contexts, or would otherwise have to obtain, compute, or interpret again at material cost.',
  'Its coverage and available fields must be sufficient for that later action.',
  'After registration, never modify or delete that Resource file; write any revised result to a new absolute path and register a new Artifact.',
  'Do not register a compact conclusion that belongs in the completed SubStep summary, a current-Epoch one-use temporary file, an unverified or incomplete file, an execution log or work note, or a final deliverable that no later work will use as input.',
])

/** One source for recovering results that earlier Context Epochs already obtained. */
export const PRIOR_WORK_RETRIEVAL_POLICY = {
  scope: 'When recovering a result already obtained in an earlier Context Epoch:',
  order: [
    'Use information still visible in the current Context when it fully covers the next action.',
    'Otherwise use a completed SubStep summary or Artifact key facts from its SubState artifact_catalog when they fully cover the next action.',
    'When exact details are needed and an Artifact coverage plus available_fields match those inputs, call read_artifact with its artifact_id instead of rediscovering the Resource file or repeating the original query.',
    'Use raw History or ordinary workspace files only when no matching Artifact exists, its declared detail is insufficient, or read_artifact reports stale.',
    'Re-query an external system only when no reliable prior result supplies the needed detail, the information must be current, or newer evidence conflicts with the saved result.',
  ],
  raw_history: 'The Agent decides which evidence is needed and uses available general-purpose History or file-reading capabilities; Governor provides navigation, not business retrieval decisions. Stored events may contain only a preview and a reference to an externalized full result. Read the referenced result through an authorized runtime capability when its exact contents are needed; re-reading the same event or switching Epochs does not restore omitted content. If the reference is inaccessible, report the access boundary and use another authorized source path or a smaller source query without broadening permissions or claiming that the preview is complete.',
} as const

/** One source for resuming an incomplete SubStep after an Epoch boundary. */
export const CONTINUATION_RECOVERY_GUIDANCE = formatGuidance([
  'A non-null current_sub_step.continuation is the active handoff for this Epoch: treat resume_from as the next work objective before ordinary recovery or re-planning.',
  'Reuse evidence-backed continuation.progress; do not re-derive or revalidate it merely to regain confidence. Preserve stated uncertainty: a handoff does not make an incomplete or unverified result verified.',
  'If resume_from requires external input, confirm that the needed input has actually been supplied before resuming affected work. A new message saying to continue or a new Context Epoch does not itself satisfy that prerequisite; otherwise preserve the unmet work and use record_continuation operation=wait_for_input again.',
  'Read a declared working_resource only when its exact contents are required to execute resume_from. Do not read unrelated Artifacts, History, or workspace files, and do not re-query external systems merely to re-establish facts already captured by the Continuation.',
  'When the Continuation records an established execution boundary, use that boundary for the next safe operation and advance it after materializing the result. Re-investigate the boundary only after that operation fails, direct evidence contradicts it, or relevant conditions change. Do not repeat a recorded failed attempt under unchanged conditions; a failure rules out the attempted operation, not every untested variant.',
  'If the remaining output cannot be materialized in one safe operation, write the next bounded portion into a real working file and update the Continuation with cumulative coverage, remaining uncertainty, and the exact next boundary; retain references to earlier portions still needed for recovery. Continue in the same Epoch when useful; saving a batch does not require a Context switch. Switch at a natural handoff or when context pressure requires it. Do not spend repeated Epochs re-reading the same inputs without advancing that boundary.',
])

/** One source for the auxiliary switch note, distinct from durable recovery state. */
export const CONTEXT_SWITCH_NOTE_GUIDANCE = formatGuidance([
  'Keep switch_context.reason brief: explain the switch and include only necessary handoff information not already captured by the durable State, SubState, or Continuation. Do not copy the full progress record; do not omit the only recovery clue merely to shorten the note.',
  'Governor carries reason into the next Epoch as switch_note and records it in the Epoch audit. This auxiliary note is not a state update, a completion claim, or verified evidence; it does not overwrite or merge into State, SubState, or Continuation.',
  'Resume from the latest durable State, SubState, and any current Continuation. If switch_note conflicts with them in a way that affects execution, check the relevant evidence and use the appropriate state tool for any justified correction; never change status, criteria, or progress solely because the note asserts a change.',
  'When no Continuation exists, use the note as a provisional recovery lead: preserve confirmed progress, relevant failed attempts and their conditions, real file paths when present, unresolved questions, and the next bounded action. If the Step has no SubState, inspect only the evidence needed to establish criteria, then call plan_current_step; do not invent a SubStep or call record_continuation before a SubState exists.',
])

/** Reconcile planned work or hand off reconnaissance without inventing completion. */
export const SWITCH_RECONCILIATION_GUIDANCE = formatGuidance([
  'Before switching, reconcile actual work with the projected SubState when one exists.',
  'Apply the constraint-recording and handoff checks in context_governor.decision_checks.after_reconnaissance.',
  CONTEXT_SWITCH_NOTE_GUIDANCE,
  'Record every completed reusable unit with advance_task_progress; if it produced exact cross-Context data, follow the register_artifact policy and reference that Artifact as produced.',
  'If the current SubStep is incomplete but has reusable progress in real workspace files, call record_continuation operation=save so the next Epoch can resume it.',
  'If no unit is complete and no reusable progress exists, keep the current SubStep active and do not invent completion, Continuation, or an Artifact.',
  'If newly discovered facts require changing not-yet-started work, use revise_step or revise_substep before switching; never rewrite current or completed work.',
  'If evidence changes an acceptance criterion, use the corresponding criteria replan tool so the effective criterion and pending coverage change together; preserve completed records.',
])

/** Shared pressure and corrective reminder; tools are chosen by capability, not name. */
export const CONTEXT_CLOSING_GUIDANCE = formatGuidance([
  'Context Governor requires a Context transition before further task work. This Epoch is now in closing mode.',
  'Stop expanding task work: do not start new business queries, external business changes, or exploration of alternative paths.',
  'Choose available tools by their actual capabilities only to preserve already obtained progress and complete the handoff. Necessary local reads, writes, or scripts are allowed for that purpose, not to collect new or unrelated task inputs.',
  'A returned tool result is not completed work until every required fact has been integrated into the task output or an intermediate artifact.',
  'Save bounded reusable progress rather than trying to finish or fully serialize all remaining work before switching. Keep incomplete or unverified work active; saving it does not make it complete.',
  SWITCH_RECONCILIATION_GUIDANCE,
  'Then call switch_context. If required external input is missing and a current SubStep exists, use record_continuation operation=wait_for_input instead to persist the handoff and end this turn without claiming completion. If the task is already complete, use advance_task_progress with complete_task instead.',
])

/** One authority for evidence-based acceptance-criteria revisions at either level. */
export const CRITERIA_REPLAN_GUIDANCE = formatGuidance([
  'Assess whether a criterion faithfully expresses the authoritative requirement separately from whether that requirement is currently achievable. Revise acceptance criteria only when authoritative evidence establishes that the original criterion misinterpreted the requirement or that the requirement has been explicitly changed. Before revising, compare the authoritative requirement, original criterion, and proposed criterion; identify the authoritative wording that justifies the change in required outcomes. source_events must support that corrected interpretation or authorized change, not merely describe an execution obstacle or a guessed evaluation expectation.',
  'Execution failure, missing resources, or capability limits do not authorize reducing required scope or replacing a required result with an explanation of why it cannot be achieved. Infeasibility alone does not establish that the original criterion misinterpreted the requirement. If achieving a required result would violate another constraint under current conditions, leave the work unresolved rather than infer permission to waive either obligation. Evidence that a requirement cannot currently be met is not evidence that it may be waived.',
  'When an obstacle prevents a required result, retain that requirement as unmet, preserve confirmed progress and the unresolved cause in the existing handoff when applicable, and report the blocker rather than superseding the criterion to make the current result pass.',
  'For criteria involving reconstructed exact inputs, apply context_governor.exact_data_transfer_policy.',
])

/** One policy for multi-call adjustments at either planning level. */
export const PENDING_PLAN_REVISION_GUIDANCE = formatGuidance([
  'Each call changes exactly one pending item and immediately persists a validated State revision. Unrelated items keep their IDs, contents, and order.',
  'Before a split or merge, determine the final plan and order the calls so every effective criterion remains covered after each commit. Add replacement work before reducing or deleting its predecessor when needed.',
  'If a call fails, use the latest returned State revision and correct the remaining operations; successful earlier calls are not rolled back. Use the criteria replan tool when the criteria themselves change.',
])
