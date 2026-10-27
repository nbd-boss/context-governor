/** Shared DSH-facing JSON Schemas. Domain validation remains in the pure contracts. */
import type { ParameterSchemaSpec } from '../../../deepseek-harness/packages/core/tools/src/index.ts'
import { DISCOVERED_CONSTRAINT_KINDS } from '../state/state-contract.ts'

const discoveredConstraintProperties = {
  kind: { type: 'string' as const, required: true, enum: [...DISCOVERED_CONSTRAINT_KINDS] },
  condition: { type: 'string' as const, required: true },
  required_behavior: { type: 'string' as const, required: true },
  source_events: {
    type: 'array' as const, required: true,
    description: 'Original event-N evidence supporting the restriction; references must exist in the current execution History. Reference validity does not establish semantic support; follow context_governor.decision_checks.after_reconnaissance.',
    items: { type: 'string' as const },
  },
} as const

export const discoveredConstraintSchema = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    constraint_id: { type: 'string' as const, required: true },
    ...discoveredConstraintProperties,
  },
} as const

export const discoveredConstraintChangeSchema = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    ...discoveredConstraintProperties,
    replaces: {
      type: 'array' as const, required: true,
      description: 'Active constraint_id values from the pre-call State to replace; [] adds an independent constraint. IDs are allocated by Governor, not supplied for new records.',
      items: { type: 'string' as const },
    },
  },
} as const

const planningItemProperties = {
  inputs: { type: 'array' as const, required: true, items: { type: 'string' as const } },
  action: { type: 'string' as const, required: true },
  result: { type: 'string' as const, required: true },
} as const

const planItemSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ...planningItemProperties,
    covers_criterion_indexes: {
      type: 'array' as const, required: true,
      description: 'Zero-based indexes into this plan\'s step_completion_criteria; every item needs at least one.',
      items: { type: 'integer' as const },
    },
  },
} as const

const stepPlanItemSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    inputs: planningItemProperties.inputs,
    step: { type: 'string' as const, required: true },
    result: planningItemProperties.result,
    covers: { type: 'array' as const, required: true, items: { type: 'integer' as const } },
  },
} as const

function changeSchema<const Fields extends ParameterSchemaSpec>(idKey: string, fields: Fields) {
  const identity = { [idKey]: { type: 'string' as const, required: true as const } }
  return {
    oneOf: [
      { type: 'object' as const, additionalProperties: false as const, properties: {
        operation: { type: 'string' as const, required: true as const, enum: ['add'] }, ...fields,
      } },
      { type: 'object' as const, additionalProperties: false as const, properties: {
        operation: { type: 'string' as const, required: true as const, enum: ['update'] }, ...identity, ...fields,
      } },
      { type: 'object' as const, additionalProperties: false as const, properties: {
        operation: { type: 'string' as const, required: true as const, enum: ['delete'] }, ...identity,
      } },
    ] as const,
  }
}

export const stepChangeSchema = changeSchema('step_id', stepPlanItemSchema.properties)

export const stepPlanSchema = {
  type: 'object' as const,
  required: true,
  additionalProperties: false,
  properties: {
    completion_criteria: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    steps: { type: 'array' as const, required: true, items: stepPlanItemSchema },
  },
} as const

export const subStepChangeSchema = changeSchema('sub_step_id', {
    ...planningItemProperties,
    covers_criterion_ids: {
      type: 'array' as const, required: true,
      description: 'Existing criterion_id values from current_sub_state.step_completion_criteria.',
      items: { type: 'string' as const },
    },
})

export const replannedSubStepChangeSchema = changeSchema('sub_step_id', {
    ...planningItemProperties,
    covers_criterion_indexes: {
      type: 'array' as const, required: true,
      description: 'Zero-based indexes into the existing step_completion_criteria followed by add_criteria.',
      items: { type: 'integer' as const },
    },
})

export const subStepPlanSchema = {
  type: 'object' as const,
  required: true,
  additionalProperties: false,
  properties: {
    step_completion_criteria: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    sub_steps: { type: 'array' as const, required: true, items: planItemSchema },
  },
} as const

export const stateOutputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer' as const, required: true },
    revision: { type: 'integer' as const, required: true },
    mission: { type: 'string' as const, required: true },
    task_plan: {
      type: 'object' as const, required: true, additionalProperties: false,
      properties: {
        next_step_number: { type: 'integer' as const, required: true },
        completion_criteria: { type: 'array' as const, required: true, items: { type: 'string' as const } },
        superseded_criteria: { type: 'array' as const, required: true, items: { type: 'integer' as const } },
        steps: {
          type: 'array' as const, required: true,
          items: {
            type: 'object' as const, additionalProperties: false,
            properties: {
              step_id: { type: 'string' as const, required: true },
              step: { type: 'string' as const, required: true },
              status: { type: 'string' as const, required: true },
              covers: { type: 'array' as const, required: true, items: { type: 'integer' as const } },
            },
          },
        },
      },
    },
    user_constraints: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    next_constraint_number: { type: 'integer' as const, required: true },
    discovered_constraints: {
      type: 'array' as const, required: true,
      items: discoveredConstraintSchema,
    },
    lifecycle: { type: 'object' as const, required: true, additionalProperties: false, properties: { status: { type: 'string' as const, required: true } } },
  },
} as const

/** Exact Artifact metadata shared by registration, retrieval, and runtime navigation. */
export const artifactContainsSchema = {
  type: 'object', required: true, additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    coverage: { type: 'string', required: true },
    key_facts: { type: 'array', required: true, items: { type: 'string' } },
    available_fields: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const plannedSubStepProperties = {
  sub_step_id: { type: 'string', required: true },
  action: { type: 'string', required: true },
  covers: { type: 'array', required: true, items: { type: 'string' } },
} as const

/** Shared tool output fields; no conversion or copy of the domain snapshot is needed. */
export const subStateOutputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', required: true },
    step_id: { type: 'string', required: true },
    next_sub_step_number: { type: 'integer', required: true },
    step_completion_criteria: {
      type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: {
        criterion_id: { type: 'string', required: true },
        criterion: { type: 'string', required: true },
      } },
    },
    superseded_criterion_ids: { type: 'array', required: true, items: { type: 'string' } },
    completed_sub_steps: {
      type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: {
        ...plannedSubStepProperties,
        summary: { type: 'string', required: true },
        criterion_evidence: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            criterion_id: { type: 'string', required: true },
            source_events: { type: 'array', required: true, items: { type: 'string' } },
          },
        } },
        artifact_refs: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            artifact_id: { type: 'string', required: true },
            relation: { type: 'string', required: true, enum: ['produced', 'used'] },
          },
        } },
      } },
    },
    current_sub_step: {
      required: true,
      oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          ...plannedSubStepProperties,
          continuation: { required: true, oneOf: [
            { type: 'object', additionalProperties: false, properties: {
              progress: { type: 'string', required: true },
              working_resources: { type: 'array', required: true, items: {
                type: 'object', additionalProperties: false, properties: {
                  path: { type: 'string', required: true },
                  contains: { type: 'string', required: true },
                },
              } },
              resume_from: { type: 'string', required: true },
            } },
            { type: 'null' },
          ] },
        } },
        { type: 'null' },
      ],
    },
    pending_sub_steps: {
      type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: plannedSubStepProperties },
    },
  },
} as const

export const nullableSubStateOutputSchema = {
  required: true,
  oneOf: [subStateOutputSchema, { type: 'null' }],
} as const
