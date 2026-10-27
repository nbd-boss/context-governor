import assert from 'node:assert/strict'
import test from 'node:test'

import { ARTIFACT_SELECTION_GUIDANCE, CONTEXT_CLOSING_GUIDANCE, CONTEXT_SWITCH_NOTE_GUIDANCE, CONTINUATION_RECOVERY_GUIDANCE, DECISION_CHECK_USAGE, DECISION_CHECKS, EXACT_DATA_TRANSFER_GUIDANCE, formatDecisionCheck, PARENT_OUTCOME_REQUIREMENTS, PENDING_PLAN_REVISION_GUIDANCE, PLANNING_CORE_GUIDANCE, PRIOR_WORK_RETRIEVAL_POLICY, STEP_PLANNING_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE, SWITCH_RECONCILIATION_GUIDANCE, TASK_COMPLETION_CRITERIA_GUIDANCE } from '../src/agent-guidance.ts'
import { ADVANCE_TASK_PROGRESS_DESCRIPTION } from '../src/tools/advance-task-progress-tool.ts'
import { REGISTER_ARTIFACT_DESCRIPTION } from '../src/tools/artifact-tools.ts'
import { RECORD_CONTINUATION_DESCRIPTION } from '../src/tools/record-continuation-tool.ts'
import { REVISE_SUBSTEP_DESCRIPTION } from '../src/tools/revise-substep-tool.ts'
import { SWITCH_CONTEXT_DESCRIPTION } from '../src/tools/switch-context-tool.ts'

test('keeps three decision phases with named checks rather than independent per-sentence triggers', () => {
  assert.deepEqual(Object.keys(DECISION_CHECKS.before_scope_or_external_change.checks), [
    'scope_boundary', 'evidence_quality', 'identity_and_exclusion', 'deterministic_selection', 'known_constraints', 'recovery_effect',
  ])
  assert.deepEqual(Object.keys(DECISION_CHECKS.after_reconnaissance.checks), [
    'state_semantics', 'authoritative_outcome', 'change_boundary', 'constraint_recording', 'constraint_replacement', 'constraint_handoff',
  ])
  assert.deepEqual(Object.keys(DECISION_CHECKS.before_completion.checks), [
    'criteria_coverage', 'source_correctness', 'tool_outcome', 'authoritative_state',
  ])
  assert.match(DECISION_CHECK_USAGE, /evaluate every applicable named check/)
  assert.match(DECISION_CHECK_USAGE, /satisfying one check does not satisfy the whole phase/)
  assert.match(DECISION_CHECK_USAGE, /Skip inapplicable checks without adding unrelated work/)
})

test('renders every requirement once under its own name from the shared decision source', () => {
  for (const name of Object.keys(DECISION_CHECKS) as Array<keyof typeof DECISION_CHECKS>) {
    const rule = DECISION_CHECKS[name]
    const rendered = formatDecisionCheck(name)
    assert.ok(rendered.startsWith(rule.when))
    assert.equal(rendered.split(DECISION_CHECK_USAGE).length, 2)
    for (const [check, requirements] of Object.entries(rule.checks)) {
      assert.ok(requirements.length > 0)
      const block = `${check}:\n${requirements.map(item => `- ${item}`).join('\n')}`
      assert.equal(rendered.split(block).length, 2, `${name}.${check}`)
    }
    assert.ok(rendered.endsWith(`If unverified: ${rule.if_unverified}`))
  }
})

test('presents ordinary Guidance as lists without double-bulleting shared handoff rules', () => {
  const policies = [
    EXACT_DATA_TRANSFER_GUIDANCE, PLANNING_CORE_GUIDANCE, TASK_COMPLETION_CRITERIA_GUIDANCE,
    STEP_PLANNING_GUIDANCE, SUB_STEP_PLANNING_GUIDANCE, ARTIFACT_SELECTION_GUIDANCE,
    CONTINUATION_RECOVERY_GUIDANCE, CONTEXT_SWITCH_NOTE_GUIDANCE,
    SWITCH_RECONCILIATION_GUIDANCE, CONTEXT_CLOSING_GUIDANCE, PENDING_PLAN_REVISION_GUIDANCE,
  ]
  for (const policy of policies) {
    const lines = policy.split('\n')
    assert.ok(lines.length > 1)
    assert.ok(lines.every(line => line.startsWith('- ') && !line.startsWith('- - ')))
  }
  assert.equal(SWITCH_RECONCILIATION_GUIDANCE.split(CONTEXT_SWITCH_NOTE_GUIDANCE).length, 2)
  assert.ok(REGISTER_ARTIFACT_DESCRIPTION.includes(`\n\n${ARTIFACT_SELECTION_GUIDANCE}`))
  assert.ok(REVISE_SUBSTEP_DESCRIPTION.includes(`\n\n${SUB_STEP_PLANNING_GUIDANCE}`))
  assert.ok(SWITCH_CONTEXT_DESCRIPTION.includes(`\n\n${SWITCH_RECONCILIATION_GUIDANCE}`))
})

test('closing Guidance permits capability-based handoff without expanding task work or inventing completion', () => {
  assert.match(CONTEXT_CLOSING_GUIDANCE, /do not start new business queries, external business changes/)
  assert.match(CONTEXT_CLOSING_GUIDANCE, /Choose available tools by their actual capabilities/)
  assert.match(CONTEXT_CLOSING_GUIDANCE, /Necessary local reads, writes, or scripts are allowed/)
  assert.match(CONTEXT_CLOSING_GUIDANCE, /not to collect new or unrelated task inputs/)
  assert.match(CONTEXT_CLOSING_GUIDANCE, /returned tool result is not completed work/)
  assert.match(CONTEXT_CLOSING_GUIDANCE, /rather than trying to finish or fully serialize all remaining work/)
  assert.match(CONTEXT_CLOSING_GUIDANCE, /Keep incomplete or unverified work active/)
  assert.equal(CONTEXT_CLOSING_GUIDANCE.split(SWITCH_RECONCILIATION_GUIDANCE).length, 2)
  assert.ok(CONTEXT_CLOSING_GUIDANCE.includes(CONTEXT_SWITCH_NOTE_GUIDANCE))
  assert.match(CONTEXT_CLOSING_GUIDANCE, /advance_task_progress with complete_task/)
})

test('separates one planning core from Step and SubStep grain rules', () => {
  assert.match(PLANNING_CORE_GUIDANCE, /normalize every parent completion criterion/)
  assert.match(PLANNING_CORE_GUIDANCE, /Split a criterion that combines distinct outputs/)
  assert.match(PLANNING_CORE_GUIDANCE, /independently verifiable results/)
  assert.match(PLANNING_CORE_GUIDANCE, /independently proves the criterion/)
  assert.match(PLANNING_CORE_GUIDANCE, /never means partial contribution/)
  assert.match(PLANNING_CORE_GUIDANCE, /write stage must not claim validation delegated to a later stage/)
  assert.match(PLANNING_CORE_GUIDANCE, /Use covers/)
  assert.match(PLANNING_CORE_GUIDANCE, /jointly produce the same result/)
  assert.match(PLANNING_CORE_GUIDANCE, /investigation or preparation only when it produces an independently verifiable result/)
  assert.match(PLANNING_CORE_GUIDANCE, /Never invent a completion criterion merely to justify a child/)
  assert.match(STEP_PLANNING_GUIDANCE, /major stages or milestones/)
  assert.match(STEP_PLANNING_GUIDANCE, /multiple Context Epochs/)
  assert.match(STEP_PLANNING_GUIDANCE, /before calling plan_current_step/)
  assert.match(STEP_PLANNING_GUIDANCE, /If existing authoritative evidence is enough, plan immediately/)
  assert.match(STEP_PLANNING_GUIDANCE, /persists only step, status, and covers/)
  assert.match(STEP_PLANNING_GUIDANCE, /must not reinterpret or narrow/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /within one Context Epoch/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /step_completion_criteria/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /task_plan completion_criteria remain the user-facing final conditions/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /revise_substep/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /must not claim that an external action or write is complete/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /safe execution boundary/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /do not keep re-investigating it merely to regain confidence/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /one tool call/)
  assert.doesNotMatch(ADVANCE_TASK_PROGRESS_DESCRIPTION, /normalize every parent completion criterion/)
  assert.doesNotMatch(ADVANCE_TASK_PROGRESS_DESCRIPTION, /Each submitted item is one candidate SubStep/)
})

test('derives task criteria from the Mission before Step planning without creating another persisted layer', () => {
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /directly from the Mission/)
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /user-observable final condition/)
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /required coverage/)
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /do not weaken all, every, each, only, must, complete, or exact/)
})

test('keeps evidence, reconnaissance, and completion checks distinct and places them at decision tools', () => {
  const scope = formatDecisionCheck('before_scope_or_external_change')
  const reconnaissance = formatDecisionCheck('after_reconnaissance')
  const completion = formatDecisionCheck('before_completion')
  assert.match(scope, /full candidate set/)
  assert.match(scope, /direct evidence/)
  assert.match(scope, /equal identifier values/)
  assert.match(scope, /no conflicting identity attributes/)
  assert.match(scope, /unless an explicit specification or current tool result defines them as the governing rule/)
  assert.match(scope, /preserve the candidate in scope/)
  assert.match(scope, /A returned subset does not by itself establish that its selection rule is required by the task/)
  assert.match(scope, /deterministic query, filter, or join/)
  assert.match(scope, /Do not use the inference to calculate, persist a trusted conclusion/)
  assert.match(reconnaissance, /do not invent state semantics/)
  assert.match(reconnaissance, /For each external action, inspect the target system schema/)
  assert.match(reconnaissance, /fields directly evidenced to represent that action's status or time/)
  assert.match(reconnaissance, /name their required final values in the completion criterion/)
  assert.match(reconnaissance, /Step criteria and later execution SubSteps must name the required state transition and authoritative read-back/)
  assert.match(reconnaissance, /initial criteria omitted them/)
  assert.match(reconnaissance, /state transition, final value, and read-back/)
  assert.match(completion, /For a SubStep, verify its covered criteria/)
  assert.match(completion, /Keep Mission outcomes outside this Step's responsibility assigned to later work/)
  assert.match(completion, /independently compare the Mission, directly evidenced authoritative outcomes, and actual evidence/)
  assert.match(completion, /missing criterion does not waive a required outcome/)
  assert.match(completion, /authoritative persistent state/)
  assert.match(completion, /post-action update or reconciliation and its read-back as part of the same Step/)
  assert.match(completion, /Keep an unverified claimed outcome in progress/)
  assert.match(TASK_COMPLETION_CRITERIA_GUIDANCE, /authoritative persistent state to reflect every required action outcome/)
  assert.match(PLANNING_CORE_GUIDANCE, /context_governor\.decision_checks\.before_scope_or_external_change/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /context_governor\.decision_checks\.after_reconnaissance/)
  assert.match(REGISTER_ARTIFACT_DESCRIPTION, /context_governor\.decision_checks\.before_scope_or_external_change/)
  assert.match(REVISE_SUBSTEP_DESCRIPTION, /context_governor\.decision_checks\.after_reconnaissance/)
  assert.match(STEP_PLANNING_GUIDANCE, /criteria replan tool/)
  assert.doesNotMatch(REVISE_SUBSTEP_DESCRIPTION, /After learning relevant external schema/)
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, /Before completing a SubStep, Step, or task/)
  assert.doesNotMatch(PLANNING_CORE_GUIDANCE, /equal identifiers/)
  assert.doesNotMatch(ARTIFACT_SELECTION_GUIDANCE, /equal identifiers/)
  assert.deepEqual(Object.keys(DECISION_CHECKS), ['before_scope_or_external_change', 'after_reconnaissance', 'before_completion'])
})

test('keeps source authority within its assigned purpose without forbidding evidenced requirements', () => {
  const decision = formatDecisionCheck('before_scope_or_external_change')
  assert.match(decision, /source, assigned purpose, and governing meaning/)
  assert.match(decision, /Authority for one purpose does not establish authority for another/)
  assert.match(decision, /unless the requirement explicitly assigns it that role/)
  assert.match(decision, /field existence.*do not authorize a new condition/)
  assert.doesNotMatch(decision, /WooCommerce|BigQuery|first order|51 customers/)
})

test('requires evidence sufficient for the specific conclusion while allowing investigative hypotheses', () => {
  const decision = formatDecisionCheck('before_scope_or_external_change')
  assert.match(decision, /setting acceptance criteria/)
  assert.match(decision, /evidence sufficient to establish each specific conclusion/)
  assert.match(decision, /task scope, acceptance criteria, execution, recovery, or completion/)
  assert.match(decision, /merely having related observations is not enough/)
  assert.match(decision, /explicitly unverified hypotheses, usable to guide investigation/)
  assert.match(decision, /not as confirmed facts, scope boundaries, acceptance criteria, or completion claims/)
  const reference = /context_governor\.decision_checks\.before_scope_or_external_change/
  assert.match(formatDecisionCheck('before_completion'), reference)
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, reference)
  assert.doesNotMatch(formatDecisionCheck('before_completion'), /merely having related observations is not enough/)
})

test('separates requested and observed outcomes and checks constraint replacements in the shared decision policy', () => {
  const decision = formatDecisionCheck('before_scope_or_external_change')
  const observation = formatDecisionCheck('after_reconnaissance')
  assert.match(decision, /distinguish what was requested or expected from what was actually observed/)
  assert.match(decision, /identify any unverified inference/)
  assert.match(decision, /only the tested scope and conditions/)
  assert.match(observation, /ordinary task facts and completed results in SubState summaries or Artifacts/)
  assert.match(observation, /candidate recovery paths/)
  assert.match(observation, /current effective constraints and each other in the same submission/)
  assert.match(observation, /Different conditions may coexist/)
  assert.match(observation, /identify its constraint_id in replaces/)
  assert.match(observation, /leave the conflict unresolved/)
  assert.match(observation, /does not infer semantic conflicts/)
  assert.doesNotMatch(SWITCH_CONTEXT_DESCRIPTION, /what was requested or expected/)
})

test('requires evidenced business effects for substitutes and distinguishes action records from actual outcomes', () => {
  const recovery = DECISION_CHECKS.before_scope_or_external_change.checks.recovery_effect.join(' ')
  const outcome = DECISION_CHECKS.before_completion.checks.tool_outcome.join(' ')
  assert.match(recovery, /do not assume undeclared side effects/)
  assert.match(recovery, /A substitute must achieve the required business effect/)
  assert.match(outcome, /proves that record changed, not that the action occurred/)
  assert.match(outcome, /authoritative operation semantics establish that effect or direct outcome evidence confirms it/)
  for (const requirement of DECISION_CHECKS.before_completion.checks.tool_outcome) {
    assert.ok(formatDecisionCheck('before_completion').includes(requirement))
  }
})

test('separates source correctness from write consistency without treating saved conclusions as new evidence', () => {
  const scope = formatDecisionCheck('before_scope_or_external_change')
  const completion = formatDecisionCheck('before_completion')
  assert.match(scope, /Saving or repeating a conclusion in a summary, Artifact, or criterion does not provide independent evidence/)
  assert.match(completion, /Verify input coverage and the decision or calculation against authoritative requirements and source evidence/)
  assert.match(completion, /proves write consistency, not that the input scope or computation was correct/)
  assert.match(completion, /criteria or summaries copied from that value are not an independent check/)
  assert.ok(ADVANCE_TASK_PROGRESS_DESCRIPTION.includes(completion))
})

test('grounds material inputs before adopting them while reusing sufficient existing evidence', () => {
  const scope = DECISION_CHECKS.before_scope_or_external_change.checks.scope_boundary.join(' ')
  assert.match(scope, /input that changes task scope or a computed result/)
  assert.match(scope, /establish its source, assigned purpose, and governing meaning/)
  assert.match(scope, /agreement with expected labels do not authorize a new condition/)
  assert.match(scope, /ambiguous in a way that affects the result/)
  assert.match(scope, /before adopting the input as a confirmed basis for execution or completion/)
  assert.match(scope, /Reuse already sufficient evidence without unnecessary re-querying/)
  const rendered = formatDecisionCheck('before_scope_or_external_change')
  for (const requirement of DECISION_CHECKS.before_scope_or_external_change.checks.scope_boundary) {
    assert.ok(rendered.includes(`- ${requirement}`))
  }
  assert.doesNotMatch(formatDecisionCheck('after_reconnaissance'), /source, assigned purpose, and governing meaning/)
  assert.doesNotMatch(formatDecisionCheck('before_completion'), /source, assigned purpose, and governing meaning/)
})

test('preserves condition scope without treating a stricter interpretation as authoritative', () => {
  const scope = DECISION_CHECKS.before_scope_or_external_change.checks.scope_boundary.join(' ')
  assert.match(scope, /Establish the object and scope of each condition/)
  assert.match(scope, /Do not extend a scoped condition to a broader domain/)
  assert.match(scope, /add exclusion conditions from contextual labels or related wording without direct authoritative support/)
  assert.match(scope, /a stricter interpretation is not automatically the correct one/)
  assert.match(scope, /resolve that ambiguity before adopting the input as a confirmed basis/)
  assert.doesNotMatch(formatDecisionCheck('before_completion'), /a stricter interpretation is not automatically the correct one/)
})

test('separates selected-set coverage from processing success while reusing valid scope evidence', () => {
  const source = DECISION_CHECKS.before_completion.checks.source_correctness.join(' ')
  assert.match(source, /establish the rule and source coverage before using the selected set as the complete target/)
  assert.match(source, /processing every selected item does not establish that all required items were selected/)
  assert.match(source, /Reuse sufficient prior scope evidence when it remains applicable/)
  assert.match(source, /without re-querying solely to repeat this check/)
  assert.match(source, /If scope or execution remains unverified, keep the dependent completion claim unverified/)
  assert.match(source, /for complete_task, report unverified rather than met in task_criteria_check/)
  assert.ok(ADVANCE_TASK_PROGRESS_DESCRIPTION.includes(formatDecisionCheck('before_completion')))
})

test('does not treat output based on model-supplied inputs as independent evidence for those inputs', () => {
  const requirements = DECISION_CHECKS.before_completion.checks.source_correctness
  const source = requirements.join(' ')
  assert.match(source, /program or tool output derived from model-supplied inputs/)
  assert.match(source, /only the result under those inputs, not their authority or correctness/)
  assert.match(source, /trace material inputs back to their original evidence/)
  assert.match(source, /rather than treating an echoed or computed value as independent support/)
  const rendered = formatDecisionCheck('before_completion')
  for (const requirement of requirements) assert.ok(rendered.includes(`- ${requirement}`))
  assert.ok(ADVANCE_TASK_PROGRESS_DESCRIPTION.includes(rendered))
  assert.doesNotMatch(EXACT_DATA_TRANSFER_GUIDANCE, /trace material inputs back to their original evidence/)
})

test('owns change boundaries and proportionate preservation checks in the shared reconnaissance policy', () => {
  const reconnaissance = formatDecisionCheck('after_reconnaissance')
  const completion = formatDecisionCheck('before_completion')
  assert.match(reconnaissance, /authorized target records and fields using evidenced identities/)
  assert.match(reconnaissance, /preserve existing data outside that change boundary/)
  assert.match(reconnaissance, /boundary and proportionate preservation checks into affected criteria and pending work/)
  assert.match(completion, /change-boundary checks in context_governor\.decision_checks\.after_reconnaissance/)
  assert.doesNotMatch(completion, /authorized target records and fields/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /context_governor\.decision_checks\.after_reconnaissance/)
})

test('requires tool-result outcomes rather than normal call returns before recording completion', () => {
  const completion = formatDecisionCheck('before_completion')
  assert.match(completion, /actual tool-result content for failure, partial success, or an unresolved outcome/)
  assert.match(completion, /even when the call returns normally or reports no tool-level error/)
  assert.match(completion, /Resolve contradictory evidence through authoritative results before claiming success/)
  assert.match(completion, /do not convert an error into a success summary, Artifact fact, or completion claim/)
  assert.match(completion, /preserving confirmed partial progress and unresolved failures in History or an existing handoff/)
  assert.match(completion, /end the reply with a truthful partial-progress and blocker report while lifecycle.status remains active/)
  assert.match(completion, /complete_task is permitted only after successful completion, not required at the end of every attempt/)
  assert.match(completion, /do not rewrite requirements to satisfy its preconditions/)
  assert.ok(ADVANCE_TASK_PROGRESS_DESCRIPTION.includes(completion))
})

test('known limitations and completed checks cannot waive an unresolved required outcome', () => {
  const requirements = DECISION_CHECKS.before_completion.checks.criteria_coverage
  const coverage = requirements.join(' ')
  assert.match(coverage, /Keep lower-level criteria and verification reports faithful to the required parent outcomes/)
  assert.match(coverage, /Performing checks, generating a report, or recording a known limitation does not fulfill a failed or unverified required outcome/)
  assert.match(coverage, /Compare relevant known failures and unresolved outcomes with the work being completed/)
  assert.match(coverage, /Runtime constraints explain obstacles, not exemptions/)
  assert.match(coverage, /do not weaken acceptance criteria or mark affected work complete merely because the obstacle is documented/)
  const completion = formatDecisionCheck('before_completion')
  for (const requirement of requirements) {
    assert.equal(completion.split(`- ${requirement}`).length, 2)
  }
  assert.equal(ADVANCE_TASK_PROGRESS_DESCRIPTION.split(completion).length, 2)
  assert.match(completion, /Keep an unverified claimed outcome in progress/)
  assert.match(completion, /preserving confirmed partial progress and unresolved failures in History or an existing handoff/)
})

test('planning and completion share the same parent-outcome obligations and allow only authoritative alternatives', () => {
  const completion = formatDecisionCheck('before_completion')
  for (const requirement of PARENT_OUTCOME_REQUIREMENTS) {
    assert.equal(PLANNING_CORE_GUIDANCE.split(`- ${requirement}`).length, 2)
    assert.equal(completion.split(`- ${requirement}`).length, 2)
  }
  assert.match(PLANNING_CORE_GUIDANCE, /Completing investigation or exception reporting proves only that investigation or report/)
  assert.match(PLANNING_CORE_GUIDANCE, /only when the authoritative requirement explicitly permits that alternative/)
  assert.match(PLANNING_CORE_GUIDANCE, /communication duty, not permission to omit a required deliverable/)
  assert.match(PLANNING_CORE_GUIDANCE, /explicitly permits that alternative through omission, substitution, or partial delivery/)
  assert.match(completion, /competing interpretations change whether the task is complete/)
  assert.match(completion, /retain the affected requirement as unresolved, report the ambiguity, and seek user clarification when needed/)
  assert.match(completion, /do not choose an interpretation merely because it makes the current result pass/)
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, /Finishing the plan is necessary but does not itself prove task completion/)
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, /Only complete_task requires transition.task_criteria_check/)
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, /Checks remain in the original tool-call History/)
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, /not business truth/)
})

test('preserves assigned parent outcomes when deriving local criteria and before choosing a Step boundary branch', () => {
  assert.match(PLANNING_CORE_GUIDANCE, /Lower-level criteria refine, not redefine, parent obligations/)
  assert.match(PLANNING_CORE_GUIDANCE, /preserve required deliverables, scope, and conditions when creating or revising/)
  assert.match(PLANNING_CORE_GUIDANCE, /rather than deriving requirements from actual or achievable results/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /read the active Step description/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /effective State.task_plan.completion_criteria entries referenced by that Step's covers/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /applying the shared parent-outcome requirements rather than selecting only currently achievable work/)
  const completion = formatDecisionCheck('before_completion')
  assert.match(completion, /Before choosing a progress branch, determine whether the current unit is actually complete/)
  assert.match(completion, /verify its promised result and the effective task_plan.completion_criteria entries referenced by its covers/)
  assert.match(completion, /Satisfying all lower-level criteria, having no pending SubSteps, or having no executable action does not by itself establish Step completion/)
  assert.match(ADVANCE_TASK_PROGRESS_DESCRIPTION, /Use advance_step only after the current Step passes context_governor.decision_checks.before_completion/)
})

test('records evidenced runtime restrictions and applies them before execution or recovery', () => {
  const observation = formatDecisionCheck('after_reconnaissance')
  const action = formatDecisionCheck('before_scope_or_external_change')
  assert.match(observation, /runtime limitations/)
  assert.match(observation, /direct evidence confirms a runtime restriction that will govern later work/)
  assert.match(observation, /promptly call record_discovered_constraint/)
  assert.match(observation, /condition, required_behavior, and source_events identifying the supporting original events/)
  assert.match(observation, /do not leave it only in a Continuation or work note/)
  assert.match(observation, /Record only the evidenced scope/)
  assert.match(observation, /single failed or timed-out request does not establish a permanent limitation or prove whether the operation completed/)
  assert.match(observation, /current History or an existing handoff/)
  assert.match(action, /Before choosing an execution or recovery action/)
  assert.match(action, /Before retrying a path or resuming exploration/)
  assert.match(action, /compare the proposed operation with relevant State.discovered_constraints according to their condition and required_behavior/)
  assert.match(action, /do not repeat a ruled-out attempt under unchanged conditions/)
  assert.match(action, /evidence shows that its condition no longer applies/)
  assert.match(action, /intended effect is explicitly supported by the available capability or direct evidence/)
  assert.match(action, /do not assume undeclared side effects or treat an unverified recovery as successful/)
})

test('records restrictions at path decisions and uses the switch handoff even in closing mode', () => {
  const observation = formatDecisionCheck('after_reconnaissance')
  const action = formatDecisionCheck('before_scope_or_external_change')
  assert.match(observation, /before choosing another path or retrying/)
  assert.match(observation, /Before saving a handoff, check for confirmed restrictions/)
  assert.match(observation, /not already covered by State.discovered_constraints; do not duplicate existing constraints/)
  assert.match(observation, /switch_context.new_discovered_constraints, or \[\] when none remain/)
  assert.match(observation, /persists them before the next Epoch, including in closing mode/)
  assert.match(observation, /do not defer recording to the next Epoch or duplicate them in a Continuation/)
  assert.match(action, /a new Context Epoch alone is not such evidence/)
  const reference = /constraint-recording and handoff checks in context_governor\.decision_checks\.after_reconnaissance/
  assert.match(RECORD_CONTINUATION_DESCRIPTION, reference)
  assert.match(SWITCH_CONTEXT_DESCRIPTION, reference)
  // The decision check owns the rule; handoff descriptions only reference it.
  for (const description of [RECORD_CONTINUATION_DESCRIPTION, SWITCH_CONTEXT_DESCRIPTION]) {
    assert.doesNotMatch(description, /before choosing another path or retrying/)
    assert.doesNotMatch(description, /do not defer recording to the next Epoch or duplicate them in a Continuation/)
  }
})

test('distinguishes internally plausible reconstructed data from source fidelity', () => {
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /complete source coverage and a reconstruction plan/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /omissions, overlaps, reordered records/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /not by itself evidence that it corresponds completely and accurately to its source/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /explicitly incomplete or unverified/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /supported batch operations/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /code literals or write-tool arguments are model transcription, not direct transfer/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /stable identity or source position/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /compare the required field values and relationships/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /Recomputing from the same reconstructed input or reading back a downstream write does not establish source fidelity/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /Model transcription remains a last resort/)
})

test('plans source correspondence before dependent use without adding task-level deliverables', () => {
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /Shortening or encoding those values does not change this/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /make source correspondence explicit in the affected Step completion criteria/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /source verification precedes dependent use/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /do not add a new task-level deliverable/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /Verify each reconstructed portion against its source/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /including entity roles and relationship direction/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /verified exact input for dependent calculation, filtering, or external writes/)
  const reference = /context_governor\.exact_data_transfer_policy/
  assert.match(SUB_STEP_PLANNING_GUIDANCE, reference)
  assert.match(formatDecisionCheck('before_completion'), reference)
})

test('bounds completion claims to actual source-comparison evidence and reuses valid checks', () => {
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /existing completion summary and source_events/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /actual source-comparison scope and supporting evidence/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /A spot check supports only the sampled records/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /do not expand sampling, count checks, or internal consistency/)
  assert.match(EXACT_DATA_TRANSFER_GUIDANCE, /Reuse sufficient applicable comparisons without repeating them/)
})

test('ends reconnaissance at a feasible next action instead of exhaustive route exploration', () => {
  assert.match(STEP_PLANNING_GUIDANCE, /Stop pre-planning reconnaissance/)
  assert.match(STEP_PLANNING_GUIDANCE, /evidence is sufficient to establish criteria and a feasible next action/)
  assert.match(STEP_PLANNING_GUIDANCE, /do not wait to exhaust alternative routes or finish the Step's main work before planning/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /bounded operation to confirm a feasible path/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /advance the required result rather than exploring every alternative/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /operation fails, direct evidence contradicts it, or relevant conditions change/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /materialize useful partial progress in real working files/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /save it with record_continuation/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /Keep the SubStep active until its covered criteria are met/)
  assert.match(SUB_STEP_PLANNING_GUIDANCE, /a batch is not automatically a new SubStep or an Artifact/)
})

test('registers only exact cross-Context inputs that later work will reuse', () => {
  assert.match(ARTIFACT_SELECTION_GUIDANCE, /later work must reuse across Contexts/)
  assert.match(ARTIFACT_SELECTION_GUIDANCE, /never modify or delete that Resource file/)
  assert.match(ARTIFACT_SELECTION_GUIDANCE, /new absolute path/)
  assert.match(ARTIFACT_SELECTION_GUIDANCE, /final deliverable that no later work will use as input/)
  assert.match(REGISTER_ARTIFACT_DESCRIPTION, /unverified or incomplete file/)
})

test('requires switch reconciliation without fabricating incomplete progress', () => {
  assert.match(SWITCH_RECONCILIATION_GUIDANCE, /reconcile actual work with the projected SubState/)
  assert.match(SWITCH_RECONCILIATION_GUIDANCE, /keep the current SubStep active/)
  assert.match(SWITCH_CONTEXT_DESCRIPTION, /follow the register_artifact policy/)
  assert.match(SWITCH_CONTEXT_DESCRIPTION, /Completing a SubStep does not itself require a Context switch/)
  assert.match(SWITCH_RECONCILIATION_GUIDANCE, /record_continuation/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /current incomplete SubStep/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /replaces the earlier Continuation/)
  assert.doesNotMatch(SWITCH_CONTEXT_DESCRIPTION, /sub_step_outcome/)
})

test('uses verified Artifacts before raw recovery or repeated external queries', () => {
  const guidance = [PRIOR_WORK_RETRIEVAL_POLICY.scope, ...PRIOR_WORK_RETRIEVAL_POLICY.order].join(' ')
  assert.match(guidance, /Artifact coverage plus available_fields/)
  assert.match(guidance, /call read_artifact/)
  assert.ok(guidance.indexOf('call read_artifact') < guidance.indexOf('raw History or ordinary workspace files'))
  assert.ok(guidance.indexOf('raw History or ordinary workspace files') < guidance.indexOf('Re-query an external system'))
  assert.match(guidance, /read_artifact reports stale/)
})

test('keeps raw History access capability-based and distinguishes stored previews from complete results', () => {
  const policy = PRIOR_WORK_RETRIEVAL_POLICY.raw_history
  assert.match(policy, /The Agent decides which evidence is needed/)
  assert.match(policy, /available general-purpose History or file-reading capabilities/)
  assert.match(policy, /preview and a reference to an externalized full result/)
  assert.match(policy, /authorized runtime capability/)
  assert.match(policy, /switching Epochs does not restore omitted content/)
  assert.match(policy, /without broadening permissions or claiming that the preview is complete/)
})

test('switch notes remain auxiliary to durable state without imposing semantic deduplication', () => {
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /Keep switch_context.reason brief/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /Do not copy the full progress record/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /do not omit the only recovery clue/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /not a state update, a completion claim, or verified evidence/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /does not overwrite or merge into State, SubState, or Continuation/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /check the relevant evidence/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /never change status, criteria, or progress solely because the note asserts a change/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /When no Continuation exists/)
  assert.equal(SWITCH_CONTEXT_DESCRIPTION.split(CONTEXT_SWITCH_NOTE_GUIDANCE).length, 2)
})

test('treats a Continuation as an exact recovery handoff rather than a prompt to rediscover work', () => {
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /resume_from as the next work objective/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /do not re-derive or revalidate/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /declared working_resource only when its exact contents are required/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /established execution boundary/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /operation fails, direct evidence contradicts it, or relevant conditions change/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /Do not repeat a recorded failed attempt under unchanged conditions/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /not every untested variant/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /a handoff does not make an incomplete or unverified result verified/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /next bounded portion/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /cumulative coverage, remaining uncertainty, and the exact next boundary/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /retain references to earlier portions still needed/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /saving a batch does not require a Context switch/)
  assert.doesNotMatch(CONTINUATION_RECOVERY_GUIDANCE, /then switch Context/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /must not merely say to continue working/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /remaining uncertainty, and relevant failed attempts with their conditions/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /relevant failed attempts and their conditions/)
  assert.match(CONTEXT_SWITCH_NOTE_GUIDANCE, /next bounded action/)
  assert.ok(SWITCH_CONTEXT_DESCRIPTION.includes(CONTEXT_SWITCH_NOTE_GUIDANCE))
})

test('distinguishes saving progress from waiting for input without treating either as task completion', () => {
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /operation=save.*without ending the turn or switching Context/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /operation=wait_for_input.*only after the handoff is durably saved/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /Step remains in_progress and lifecycle.status remains active/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /text-only handoff; never create a placeholder file merely to stop/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /required input plus the next action once supplied in resume_from/)
  assert.match(RECORD_CONTINUATION_DESCRIPTION, /explain the blocker and required input to the user/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /confirm that the needed input has actually been supplied/)
  assert.match(CONTINUATION_RECOVERY_GUIDANCE, /new message saying to continue or a new Context Epoch does not itself satisfy that prerequisite/)
  assert.match(formatDecisionCheck('before_completion'), /record_continuation operation=wait_for_input/)
  assert.match(CONTEXT_CLOSING_GUIDANCE, /record_continuation operation=wait_for_input instead/)
  assert.match(SWITCH_RECONCILIATION_GUIDANCE, /record_continuation operation=save/)
})
