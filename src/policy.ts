import { URL } from "node:url";
import type { ActionType, ElementTarget, RiskLevel } from "./types.js";

/**
 * How to treat an action that cannot be undone by re-running the flow.
 * Default is `confirm`: irreversible steps need a human decision rather than
 * being silently executed on regulated systems.
 */
export type IrreversibleActionPolicy = "confirm" | "block" | "allow";

export type PolicyConfig = {
  allowedDomains: string[];
  allowedPathPrefixes: string[];
  allowedProtocols: string[];
  allowedActions: ActionType[];
  irreversibleActionPolicy: IrreversibleActionPolicy;
  /** Vocabulary that marks a control as writing/committing state. */
  irreversibleKeywords: string[];
  riskyKeywords: string[];
};

export const defaultPolicy: PolicyConfig = {
  allowedDomains: ["localhost", "127.0.0.1"],
  allowedPathPrefixes: ["/"],
  allowedProtocols: ["http:", "https:"],
  allowedActions: [
    "goto",
    "click",
    "type",
    "wait_for_text",
    "extract_text",
    "finish",
    "escalate",
  ],
  irreversibleActionPolicy: "confirm",
  irreversibleKeywords: [
    "transfer",
    "delete",
    "remove",
    "close account",
    "disburse",
    "approve",
    "post ",
    "withdraw",
    "pay",
    "issue",
    "confirm and submit",
  ],
  riskyKeywords: ["submit", "save", "update", "create", "open new"],
};

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

export function assertUrlAllowed(rawUrl: string, policy: PolicyConfig): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PolicyViolationError(`Malformed URL blocked by policy: ${rawUrl}`);
  }

  if (!policy.allowedProtocols.includes(url.protocol)) {
    throw new PolicyViolationError(`Protocol not allowlisted: ${url.protocol}`);
  }
  if (!policy.allowedDomains.includes(url.hostname)) {
    throw new PolicyViolationError(`Domain not allowlisted: ${url.hostname}`);
  }
  const pathAllowed = policy.allowedPathPrefixes.some((prefix) =>
    url.pathname.startsWith(prefix),
  );
  if (!pathAllowed) {
    throw new PolicyViolationError(`Route not allowlisted: ${url.pathname}`);
  }
}

export function assertActionAllowed(action: ActionType, policy: PolicyConfig): void {
  if (!policy.allowedActions.includes(action)) {
    throw new PolicyViolationError(`Action blocked by policy: ${action}`);
  }
}

/**
 * Reads intent from what the control says it does, because that is the only
 * signal available on a surface with no semantic markup.
 */
export function classifyRisk(
  action: ActionType,
  policy: PolicyConfig,
  target?: ElementTarget,
  intent?: string,
): RiskLevel {
  if (action === "goto" || action === "wait_for_text" || action === "extract_text") {
    return "safe";
  }
  if (action === "finish" || action === "escalate") {
    return "safe";
  }

  const haystack = [target?.description, target?.primary.value, intent]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (action === "click" && policy.irreversibleKeywords.some((k) => haystack.includes(k))) {
    return "irreversible";
  }
  if (action === "type") {
    return "risky";
  }
  if (action === "click" && policy.riskyKeywords.some((k) => haystack.includes(k))) {
    return "risky";
  }
  return "safe";
}
