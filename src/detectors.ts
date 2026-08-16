import type { Observation, OutcomeRule } from "./types.js";

/**
 * Conditions that occur across every back-office app we would automate, so they
 * are detected even when a capability author did not declare them. Artifact
 * rules are evaluated first and can override any of these by reusing the code.
 */
export const BUILTIN_OUTCOMES: OutcomeRule[] = [
  {
    code: "SESSION_EXPIRED",
    kind: "hard",
    description: "The application session ended; automation cannot re-authenticate on its own.",
    detect: { type: "text_present", value: "Session expired" },
    escalate: true,
  },
  {
    code: "PERMISSION_DENIED",
    kind: "hard",
    description: "The operating account lacks rights for this record or action.",
    detect: { type: "text_present", value: "Permission denied" },
    escalate: true,
  },
  {
    code: "APP_ERROR",
    kind: "hard",
    description: "The application reported an internal error.",
    detect: { type: "text_present", value: "Unexpected application error" },
    escalate: true,
  },
  {
    code: "UNEXPECTED_DIALOG",
    kind: "recoverable",
    description: "An unmodelled modal dialog appeared and was dismissed before continuing.",
    detect: { type: "dialog_opened", value: "" },
    recovery: { action: "dismiss_dialog", maxAttempts: 2, waitMs: 250 },
    escalate: false,
  },
  {
    code: "TRANSIENT_LOAD_FAILURE",
    kind: "recoverable",
    description: "The step timed out on a slow load; waiting and retrying is safe.",
    detect: { type: "action_error", value: "Timeout" },
    recovery: { action: "wait_and_retry", maxAttempts: 2, waitMs: 1500 },
    escalate: false,
  },
];

export type ConditionMatch = {
  rule: OutcomeRule;
  evidence: string;
};

/**
 * Declared rules win over built-ins, and within each group the first match wins,
 * so a capability can classify a string that would otherwise be generic.
 */
export function detectCondition(
  observation: Observation,
  declared: OutcomeRule[],
  actionError?: Error,
): ConditionMatch | undefined {
  const rules = [...declared, ...BUILTIN_OUTCOMES.filter(
    (builtin) => !declared.some((rule) => rule.code === builtin.code),
  )];

  for (const rule of rules) {
    const { type, value } = rule.detect;

    if (type === "text_present" && value && observation.text.includes(value)) {
      return { rule, evidence: `page text contains "${value}"` };
    }
    if (type === "url_contains" && value && observation.url.includes(value)) {
      return { rule, evidence: `url contains "${value}"` };
    }
    if (type === "dialog_opened" && observation.dialogs.length > 0) {
      const last = observation.dialogs[observation.dialogs.length - 1];
      if (!value || last.message.includes(value)) {
        return { rule, evidence: `dialog: "${last.message}"` };
      }
    }
    if (type === "action_error" && actionError && actionError.message.includes(value)) {
      return { rule, evidence: `action error matched "${value}"` };
    }
  }
  return undefined;
}
