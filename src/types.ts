import { z } from "zod";

export const SCHEMA_VERSION = "2.0.0";

/**
 * Surfaces we can perceive and act on. Only `web` is implemented, but replay
 * dispatches on this field so a legacy-web or desktop adapter can be added
 * without changing the recorded flow format.
 */
export const SurfaceKindSchema = z.enum(["web", "legacy_web", "desktop"]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const ActionTypeSchema = z.enum([
  "goto",
  "click",
  "type",
  "wait_for_text",
  "extract_text",
  "finish",
  "escalate",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ValueTypeSchema = z.enum(["string", "number", "boolean"]);
export type ValueType = z.infer<typeof ValueTypeSchema>;

/**
 * Ordered by how well each survives a legacy surface with no clean DOM.
 * Role/label/text describe what an operator sees; css/xpath describe markup
 * that enterprise apps regenerate freely, so they are only ever fallbacks.
 */
export const LocatorStrategySchema = z.enum([
  "role",
  "label",
  "placeholder",
  "text",
  "test_id",
  "css",
  "xpath",
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LOCATOR_STRATEGY_RANK: Record<LocatorStrategy, number> = {
  role: 0,
  label: 1,
  placeholder: 2,
  test_id: 3,
  text: 4,
  css: 5,
  xpath: 6,
};

export const LocatorCandidateSchema = z.object({
  strategy: LocatorStrategySchema,
  value: z.string(),
  role: z.string().optional(),
  exact: z.boolean().optional(),
});
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

export const ElementTargetSchema = z.object({
  description: z.string(),
  primary: LocatorCandidateSchema,
  fallbacks: z.array(LocatorCandidateSchema).default([]),
  robustness: z.string().optional(),
});
export type ElementTarget = z.infer<typeof ElementTargetSchema>;

export const RiskLevelSchema = z.enum(["safe", "risky", "irreversible"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const FlowStepSchema = z.object({
  id: z.string(),
  action: ActionTypeSchema,
  target: ElementTargetSchema.optional(),
  valueTemplate: z.string().optional(),
  expectedText: z.string().optional(),
  outputKey: z.string().optional(),
  intent: z.string().optional(),
  risk: RiskLevelSchema.default("safe"),
  optional: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(10_000),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const InputParamSchema = z.object({
  type: ValueTypeSchema,
  required: z.boolean(),
  description: z.string(),
  example: z.string().optional(),
  pattern: z.string().optional(),
  sensitive: z.boolean().default(false),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputFieldSchema = z.object({
  type: ValueTypeSchema,
  description: z.string(),
  sensitive: z.boolean().default(false),
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

export const CheckpointSchema = z.object({
  type: z.enum(["text_present", "url_contains", "element_visible"]),
  value: z.string(),
  target: ElementTargetSchema.optional(),
  timeoutMs: z.number().int().positive().default(10_000),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/**
 * The three-way split the caller contract depends on:
 * - business: a legitimate answer the caller asked for ("no such member")
 * - recoverable: the run can continue after a defined remedy
 * - hard: stop and surface a debuggable error
 */
export const OutcomeKindSchema = z.enum(["business", "recoverable", "hard"]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

export const RecoverySchema = z.object({
  action: z.enum(["dismiss_dialog", "wait_and_retry", "reload_and_retry"]),
  maxAttempts: z.number().int().positive().default(2),
  waitMs: z.number().int().nonnegative().default(1000),
});
export type Recovery = z.infer<typeof RecoverySchema>;

export const OutcomeRuleSchema = z.object({
  code: z.string(),
  kind: OutcomeKindSchema,
  description: z.string(),
  detect: z.object({
    type: z.enum(["text_present", "url_contains", "dialog_opened", "action_error"]),
    value: z.string(),
  }),
  recovery: RecoverySchema.optional(),
  escalate: z.boolean().default(false),
});
export type OutcomeRule = z.infer<typeof OutcomeRuleSchema>;

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),

  capability: z.object({
    id: z.string(),
    name: z.string(),
    revision: z.number().int().positive(),
    status: z.enum(["draft", "approved"]).default("draft"),
    description: z.string(),
  }),

  /**
   * `appId` + `appVersion` identify the vendor product; `tenantId` identifies
   * the institution running it. A capability recorded against the base app can
   * be reused by any tenant on the same appId, with per-tenant overrides layered
   * on top rather than re-recording the flow.
   */
  target: z.object({
    surface: SurfaceKindSchema,
    entryUrl: z.string(),
    appId: z.string(),
    appVersion: z.string().default("unknown"),
    tenantId: z.string().default("base"),
    allowedDomains: z.array(z.string()),
    allowedPathPrefixes: z.array(z.string()).default(["/"]),
  }),

  inputs: z.record(z.string(), InputParamSchema),
  outputs: z.record(z.string(), OutputFieldSchema),
  successCheckpoint: CheckpointSchema,
  outcomes: z.array(OutcomeRuleSchema).default([]),
  steps: z.array(FlowStepSchema),

  provenance: z.object({
    createdAt: z.string(),
    createdBy: z.string(),
    goal: z.string(),
    model: z.string(),
    discoveryRunId: z.string(),
    /** Set when this artifact was resolved from a base capability + tenant overrides. */
    derivedFrom: z
      .object({
        baseTenantId: z.string(),
        overrideId: z.string(),
        appliedPatches: z.array(z.string()),
      })
      .optional(),
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

/**
 * A sparse patch layered over a base capability so tenants running the same
 * vendor product reuse one recording instead of re-recording it each.
 *
 * Only the deltas are expressed: a relabelled control, an extra interstitial,
 * a different entry URL. Everything unstated is inherited, so a fix to the base
 * flow reaches every tenant without touching their override files.
 */
export const CapabilityOverrideSchema = z.object({
  overrideId: z.string(),
  description: z.string(),
  /** Must match the base artifact, so an override cannot be applied to the wrong product. */
  appId: z.string(),
  /** When set, the override only applies to this version of the vendor product. */
  appVersion: z.string().optional(),
  tenantId: z.string(),

  target: z
    .object({
      entryUrl: z.string().optional(),
      allowedDomains: z.array(z.string()).optional(),
      allowedPathPrefixes: z.array(z.string()).optional(),
    })
    .default({}),

  /** Replace parts of an existing step, keyed by its stable step id. */
  stepPatches: z
    .record(
      z.string(),
      z.object({
        target: ElementTargetSchema.optional(),
        valueTemplate: z.string().optional(),
        expectedText: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        optional: z.boolean().optional(),
        risk: RiskLevelSchema.optional(),
      }),
    )
    .default({}),

  /** Insert tenant-specific steps (a local interstitial, an extra confirmation). */
  insertSteps: z
    .array(
      z.object({
        after: z.string().optional(),
        before: z.string().optional(),
        step: FlowStepSchema,
      }),
    )
    .default([]),

  /** Remove base steps this tenant's configuration does not present. */
  removeSteps: z.array(z.string()).default([]),

  /** Added by code, or replacing a base rule of the same code. */
  outcomes: z.array(OutcomeRuleSchema).default([]),

  successCheckpoint: CheckpointSchema.optional(),
});
export type CapabilityOverride = z.infer<typeof CapabilityOverrideSchema>;

export const ControlOwnerSchema = z.enum(["automation", "human"]);
export type ControlOwner = z.infer<typeof ControlOwnerSchema>;

export const FailureClassificationSchema = z.enum([
  "input_invalid",
  "policy_violation",
  "recoverable_exhausted",
  "checkpoint_failed",
  "hard_failure",
]);
export type FailureClassification = z.infer<typeof FailureClassificationSchema>;

export const ReplayResultSchema = z.object({
  status: z.enum(["success", "business_outcome", "failure"]),
  capability: z.object({
    id: z.string(),
    name: z.string(),
    revision: z.number().int(),
  }),
  outputs: z.record(z.string(), z.unknown()).default({}),
  businessOutcome: z
    .object({
      code: z.string(),
      description: z.string(),
      detectedAtStep: z.string().optional(),
    })
    .optional(),
  failure: z
    .object({
      classification: FailureClassificationSchema,
      stepId: z.string().optional(),
      stepIntent: z.string().optional(),
      expected: z.string().optional(),
      observed: z.string(),
      conditionCode: z.string().optional(),
    })
    .optional(),
  recoveries: z
    .array(
      z.object({
        stepId: z.string(),
        code: z.string(),
        action: z.string(),
        attempt: z.number().int(),
      }),
    )
    .default([]),
  escalation: z
    .object({
      requested: z.boolean(),
      resolved: z.boolean(),
      reason: z.string(),
      operator: z.string().optional(),
    })
    .optional(),
  controlOwnerAtEnd: ControlOwnerSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  evidenceDir: z.string(),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export type RunInput = Record<string, string | number | boolean>;

export type DialogRecord = {
  type: string;
  message: string;
  at: string;
  handledBy: "auto_dismiss";
};

export type Observation = {
  url: string;
  title: string;
  text: string;
  /** Accessibility tree: the perception channel that survives a messy DOM. */
  ariaSnapshot: string;
  dialogs: DialogRecord[];
};

export const AgentDecisionSchema = z.object({
  action: ActionTypeSchema,
  rationale: z.string(),
  target: ElementTargetSchema.optional(),
  value: z.string().optional(),
  expectedText: z.string().optional(),
  outputKey: z.string().optional(),
  checkpointText: z.string().optional(),
  escalateReason: z.string().optional(),
});
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/**
 * The reviewable half of a capability: what it takes, what it returns, and what
 * counts as done. Authored up front; discovery only fills in the steps.
 */
export const CapabilitySpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  appId: z.string(),
  appVersion: z.string().default("unknown"),
  tenantId: z.string().default("base"),
  inputs: z.record(z.string(), InputParamSchema).default({}),
  outputs: z.record(z.string(), OutputFieldSchema).default({}),
  successCheckpoint: CheckpointSchema.optional(),
  outcomes: z.array(OutcomeRuleSchema).default([]),
});
export type CapabilitySpec = z.infer<typeof CapabilitySpecSchema>;
