/** One source for the result-first method shared by both planning levels. */
export const PLANNING_CORE_GUIDANCE = [
  'Before planning children, normalize every parent completion criterion into one observable condition at this planning level. Split a criterion that combines distinct outputs, files, or conditions that different children would establish.',
  'Work result-first from the complete parent acceptance criteria: identify independently verifiable results, then give each result its conceptual inputs and one main unit of work.',
  'Multiple inputs belong together only when they jointly produce the same result and share one verification boundary.',
  'Before submitting, split any result that actually contains two outputs that could be saved, verified, or reused independently.',
  'List a criterion in a child covers only when that child\'s completed result independently proves the criterion. covers never means partial contribution; if multiple children must jointly establish a criterion, split that parent criterion first.',
  'A planning level may claim only results established at that level: a write stage must not claim validation delegated to a later stage.',
  'Use covers to ensure every parent criterion is covered and remove unrelated or duplicate work.',
].join(' ')

/** One source for translating the user task into its sole persisted task-level acceptance criteria. */
export const TASK_COMPLETION_CRITERIA_GUIDANCE = [
  'Before planning Steps, derive the complete task_plan completion_criteria directly from the Mission while respecting direct user constraints.',
  'Each criterion must state a user-observable final condition, not an implementation action or a claim that an internal step occurred.',
  'Capture every independent required deliverable, required coverage, decision rule that affects the result, and required output condition such as format, ordering, or compatibility.',
  'Preserve the Mission\'s required scope and force: do not weaken all, every, each, only, must, complete, or exact requirements into related, target, needed, or partial work.',
].join(' ')

/** One source for model-visible top-level Step planning rules. */
export const STEP_PLANNING_GUIDANCE = [
  'Plan the whole Mission as ordered major stages or milestones. A Step may span multiple Context Epochs and may contain several related reusable results, but completing it must materially advance the overall task stage.',
  'Steps implement the fixed task completion criteria; they must not reinterpret or narrow required deliverables, coverage, or decision rules.',
  'Do not create a Step for one tool call, one file read, one search, one implementation detail, or an arbitrary fixed item batch.',
  'For each Step, inputs and result are planning-only explanations; Governor persists only step, status, and covers.',
].join(' ')

/** One source for model-visible SubStep-specific planning rules. */
export const SUB_STEP_PLANNING_GUIDANCE = [
  'For the current Step, derive observable step_completion_criteria from the authoritative user request, Step, constraints, and referenced specifications.',
  'Each submitted item is one candidate SubStep with one independently verifiable and reusable result that can normally be advanced within one Context Epoch.',
  'inputs and result are planning-only explanations; Governor persists only action, completion_criteria, and covers.',
  'Never create a SubStep for one tool call, one file read, one search, or unverified partial work.',
].join(' ')

/** One source for deciding whether an exact file belongs in the Artifact layer. */
export const ARTIFACT_SELECTION_GUIDANCE = [
  'Register an Artifact only when a verified structured file contains exact details that later work must reuse across Contexts, or would otherwise have to obtain, compute, or interpret again at material cost.',
  'Its coverage and available fields must be sufficient for that later action.',
  'After registration, never modify or delete that Resource file; write any revised result to a new absolute path and register a new Artifact.',
  'Do not register a compact conclusion that belongs in the completed SubStep summary, a current-Epoch one-use temporary file, an unverified or incomplete file, an execution log or work note, or a final deliverable that no later work will use as input.',
].join(' ')

/** One source for recovering results that earlier Context Epochs already obtained. */
export const PRIOR_WORK_RETRIEVAL_POLICY = {
  scope: 'When recovering a result already obtained in an earlier Context Epoch:',
  order: [
    'Use information still visible in the current Context when it fully covers the next action.',
    'Otherwise use a completed SubStep summary or its expanded Artifact key facts when they fully cover the next action.',
    'When exact details are needed and an Artifact coverage plus available_fields match those inputs, call read_artifact with its artifact_id instead of rediscovering the Resource file or repeating the original query.',
    'Use raw History or ordinary workspace files only when no matching Artifact exists, its declared detail is insufficient, or read_artifact reports stale.',
    'Re-query an external system only when no reliable prior result supplies the needed detail, the information must be current, or newer evidence conflicts with the saved result.',
  ],
} as const

/** One source for resuming an incomplete SubStep after an Epoch boundary. */
export const CONTINUATION_RECOVERY_GUIDANCE = [
  'A non-null current_sub_step.continuation is the active handoff for this Epoch: treat resume_from as the next work objective before ordinary recovery or re-planning.',
  'Treat continuation.progress as established progress; do not re-derive or revalidate it merely to regain confidence.',
  'Read a declared working_resource only when its exact contents are required to execute resume_from. Do not read unrelated Artifacts, History, or workspace files, and do not re-query external systems merely to re-establish facts already captured by the Continuation.',
  'If the remaining output cannot be materialized in one safe operation, write the next bounded portion into a real working file, replace the Continuation with the exact next boundary, then switch Context. Do not spend repeated Epochs re-reading the same inputs without advancing that boundary.',
].join(' ')

/** One source for the Agent's semantic reconciliation before a Context switch. */
export const SWITCH_RECONCILIATION_GUIDANCE = [
  'Before switching, reconcile actual work with the projected SubState.',
  'Record every completed reusable unit with advance_task_progress; if it produced exact cross-Context data, follow the register_artifact policy and reference that Artifact as produced.',
  'If the current SubStep is incomplete but has reusable progress in real workspace files, call record_epoch_continuation so the next Epoch can resume it.',
  'If no unit is complete and no reusable progress exists, keep the current SubStep active and do not invent completion, Continuation, or an Artifact.',
  'If newly discovered facts require changing only not-yet-started work, replace the complete pending plan before switching; never rewrite the current or completed SubSteps.',
].join(' ')
