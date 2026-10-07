/** Shared DSH-facing JSON Schemas. Domain validation remains in the pure contracts. */

const planningItemProperties = {
  inputs: { type: 'array' as const, required: true, items: { type: 'string' as const } },
  action: { type: 'string' as const, required: true },
  result: { type: 'string' as const, required: true },
  completion_criteria: { type: 'array' as const, required: true, items: { type: 'string' as const } },
} as const

const planItemSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ...planningItemProperties,
    covers: { type: 'array' as const, required: true, items: { type: 'integer' as const } },
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

export const pendingStepPlanItemSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    step_id: { type: 'string' as const },
    ...stepPlanItemSchema.properties,
  },
} as const

export const stepPlanSchema = {
  type: 'object' as const,
  required: true,
  additionalProperties: false,
  properties: {
    completion_criteria: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    steps: { type: 'array' as const, required: true, items: stepPlanItemSchema },
  },
} as const

export const pendingSubStepPlanItemSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ...planningItemProperties,
    covers: { type: 'array' as const, required: true, items: { type: 'string' as const } },
  },
} as const

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
        completion_criteria: { type: 'array' as const, required: true, items: { type: 'string' as const } },
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
    discovered_constraints: {
      type: 'array' as const, required: true,
      items: {
        type: 'object' as const, additionalProperties: false,
        properties: {
          kind: { type: 'string' as const, required: true },
          condition: { type: 'string' as const, required: true },
          required_behavior: { type: 'string' as const, required: true },
          source_events: { type: 'array' as const, required: true, items: { type: 'string' as const } },
        },
      },
    },
    lifecycle: { type: 'object' as const, required: true, additionalProperties: false, properties: { status: { type: 'string' as const, required: true } } },
  },
} as const
