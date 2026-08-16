import { escalateToHuman } from "./escalation.js";
import type { RunLogger } from "./logger.js";
import type { PolicyConfig } from "./policy.js";
import type { SessionControl } from "./session-control.js";
import type { Surface } from "./surface.js";
import type { RiskLevel } from "./types.js";

export type RiskGateOutcome = {
  allowed: boolean;
  reason?: string;
  operator?: string;
};

export type RiskGateOptions = {
  risk: RiskLevel;
  policy: PolicyConfig;
  logger: RunLogger;
  control: SessionControl;
  surface: Surface;
  evidenceDir: string;
  capability: string;
  goal: string;
  stepId: string;
  stepIntent: string;
  interactive: boolean;
  sessionVisible: boolean;
  escalationTimeoutMs: number;
  pollIntervalMs: number;
};

/**
 * Safe and risky steps proceed (risky ones are flagged for audit); irreversible
 * steps are held until policy or a human authorises them. Flagging reversible
 * writes rather than blocking them keeps ordinary data entry unattended, which
 * is the whole point of replay, while money movement and deletions never happen
 * without a decision on record.
 */
export async function gateRiskyStep(options: RiskGateOptions): Promise<RiskGateOutcome> {
  if (options.risk === "safe") {
    return { allowed: true };
  }

  if (options.risk === "risky") {
    await options.logger.log({
      type: "risky_step_flagged",
      stepId: options.stepId,
      intent: options.stepIntent,
    });
    return { allowed: true };
  }

  if (options.policy.irreversibleActionPolicy === "allow") {
    await options.logger.log({
      type: "irreversible_step_allowed_by_policy",
      stepId: options.stepId,
      intent: options.stepIntent,
    });
    return { allowed: true };
  }

  if (options.policy.irreversibleActionPolicy === "block") {
    await options.logger.log({
      type: "irreversible_step_blocked",
      stepId: options.stepId,
      intent: options.stepIntent,
    });
    return {
      allowed: false,
      reason: `Irreversible step "${options.stepIntent}" blocked by policy`,
    };
  }

  const resolution = await escalateToHuman({
    logger: options.logger,
    control: options.control,
    surface: options.surface,
    evidenceDir: options.evidenceDir,
    capability: options.capability,
    goal: options.goal,
    reason: `Irreversible action requires human confirmation: ${options.stepIntent}`,
    conditionCode: "IRREVERSIBLE_ACTION_CONFIRMATION",
    stepId: options.stepId,
    stepIntent: options.stepIntent,
    interactive: options.interactive,
    sessionVisible: options.sessionVisible,
    waitTimeoutMs: options.escalationTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
  });

  return {
    allowed: resolution.action === "resume",
    reason:
      resolution.action === "resume"
        ? undefined
        : `Operator ${resolution.operator} declined the irreversible step`,
    operator: resolution.operator,
  };
}
