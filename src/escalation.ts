import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { nowStamp, readJson, writeJson } from "./fs-utils.js";
import type { RunLogger } from "./logger.js";
import type { SessionControl } from "./session-control.js";
import type { Surface } from "./surface.js";

export type InterventionRequest = {
  interventionId: string;
  sessionId: string;
  capability: string;
  goal: string;
  reason: string;
  conditionCode?: string;
  stepId?: string;
  stepIntent?: string;
  url: string;
  screenshotPath: string;
  snapshotPaths: string[];
  /** Where the operator attaches to take control of this same live session. */
  takeoverEndpoint?: string;
  /** Whether a human has any route to this session, and how to use it. */
  access: { actionable: boolean; instructions: string[] };
  requestedAt: string;
  status: "awaiting_operator";
};

export type InterventionResolution = {
  interventionId: string;
  operator: string;
  notes: string;
  /** Structured record of what the human did on the live session. */
  manualActions?: string[];
  action: "resume" | "abort";
  resolvedAt: string;
  urlBefore: string;
  urlAfter: string;
  urlChanged: boolean;
  /** True when the accessibility tree differed across the handoff. */
  pageChanged: boolean;
};

type OperatorReportedFields = Omit<
  InterventionResolution,
  "urlBefore" | "urlAfter" | "urlChanged" | "pageChanged"
>;

/** Accessibility snapshots, not URLs, are the source of truth for page change. */
export function accessibilityTreesDiffer(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}

async function ariaSnapshotChanged(beforePaths: string[], afterPaths: string[]): Promise<boolean> {
  const beforeAria = beforePaths.find((filePath) => filePath.endsWith(".aria.txt"));
  const afterAria = afterPaths.find((filePath) => filePath.endsWith(".aria.txt"));
  if (!beforeAria || !afterAria) {
    return false;
  }
  const [before, after] = await Promise.all([
    readFile(beforeAria, "utf8"),
    readFile(afterAria, "utf8"),
  ]);
  return accessibilityTreesDiffer(before, after);
}

export type EscalationOptions = {
  logger: RunLogger;
  control: SessionControl;
  surface: Surface;
  evidenceDir: string;
  capability: string;
  goal: string;
  reason: string;
  conditionCode?: string;
  stepId?: string;
  stepIntent?: string;
  /** Prompt on the terminal; otherwise poll for an operator-console signal. */
  interactive: boolean;
  /** False when the browser is headless, i.e. there is no window to click in. */
  sessionVisible: boolean;
  waitTimeoutMs: number;
  pollIntervalMs: number;
};

/**
 * A handoff is only real if the human can actually reach the session. Being
 * explicit about this stops the system asking someone to "take control" of a
 * session they have no way to touch.
 */
function describeAccess(
  sessionVisible: boolean,
  takeoverEndpoint: string | undefined,
): { actionable: boolean; instructions: string[] } {
  const instructions: string[] = [];
  if (sessionVisible) {
    instructions.push("The browser window is open on your desktop — act in it directly.");
  }
  if (takeoverEndpoint) {
    instructions.push(
      `Attach to the same session at ${takeoverEndpoint}, or use: npm run operator -- --resolve <dir> --click "<button>"`,
    );
  }
  if (instructions.length === 0) {
    instructions.push(
      "WARNING: this session is headless and exposes no takeover endpoint, so it cannot be operated.",
      "Re-run with HEADLESS=false to get a window, or --takeoverPort 9222 to attach a console.",
    );
  }
  return { actionable: sessionVisible || Boolean(takeoverEndpoint), instructions };
}

export function interventionDir(evidenceDir: string, interventionId: string): string {
  return path.join(evidenceDir, "interventions", interventionId);
}

/**
 * Pauses automation, hands the *same* live session to a human, waits for them to
 * finish, records what changed, and takes control back. The wait has two
 * implementations so the mechanism is real in both a manned terminal and an
 * unattended run driven by the operator console.
 */
export async function escalateToHuman(
  options: EscalationOptions,
): Promise<InterventionResolution> {
  const interventionId = `int-${nowStamp()}`;
  const dir = interventionDir(options.evidenceDir, interventionId);
  const urlBefore = options.surface.currentUrl();

  const screenshotPath = await options.surface.captureScreenshot(dir, "before-handoff");
  const snapshotPaths = await options.surface.captureSnapshot(dir, "before-handoff");
  const takeoverEndpoint = options.surface.takeoverEndpoint();
  const access = describeAccess(options.sessionVisible, takeoverEndpoint);

  const request: InterventionRequest = {
    interventionId,
    sessionId: options.control.id(),
    capability: options.capability,
    goal: options.goal,
    reason: options.reason,
    conditionCode: options.conditionCode,
    stepId: options.stepId,
    stepIntent: options.stepIntent,
    url: urlBefore,
    screenshotPath,
    snapshotPaths,
    takeoverEndpoint,
    access,
    requestedAt: new Date().toISOString(),
    status: "awaiting_operator",
  };

  await writeJson(path.join(dir, "request.json"), request);
  await options.logger.log({ type: "intervention_requested", request });
  if (!access.actionable) {
    await options.logger.log({
      type: "intervention_unactionable",
      interventionId,
      note: "Escalated, but the session is not reachable by a human operator.",
    });
  }
  await options.control.transferTo("human", options.reason);

  const resolution = options.interactive
    ? await promptOperator(interventionId, request)
    : await awaitOperatorConsole(dir, interventionId, options);

  const urlAfter = options.surface.currentUrl();
  await options.surface.captureScreenshot(dir, "after-handoff");
  const afterSnapshotPaths = await options.surface.captureSnapshot(dir, "after-handoff");
  const resolved: InterventionResolution = {
    ...resolution,
    urlBefore,
    urlAfter,
    urlChanged: urlBefore !== urlAfter,
    pageChanged: await ariaSnapshotChanged(snapshotPaths, afterSnapshotPaths),
  };

  await writeJson(path.join(dir, "resolution.json"), resolved);
  await options.logger.log({ type: "intervention_resolved", resolution: resolved });

  if (resolved.action === "resume") {
    await options.control.transferTo("automation", "operator handed control back");
  }
  return resolved;
}

async function promptOperator(
  interventionId: string,
  request: InterventionRequest,
): Promise<OperatorReportedFields> {
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write("\n=== HUMAN INTERVENTION REQUIRED ===\n");
  stdout.write(`Capability : ${request.capability}\n`);
  stdout.write(`Step       : ${request.stepId ?? "n/a"} (${request.stepIntent ?? "n/a"})\n`);
  stdout.write(`Reason     : ${request.reason}\n`);
  stdout.write(`URL        : ${request.url}\n`);
  stdout.write(`Screenshot : ${request.screenshotPath}\n`);
  stdout.write("\nHow to take control:\n");
  for (const line of request.access.instructions) {
    stdout.write(`  - ${line}\n`);
  }
  stdout.write(
    "\nControl is yours. Resolve the condition on the live session, then answer below.\n" +
      "Answering 'y' without changing anything will simply re-detect the same condition.\n\n",
  );

  const operator = (await rl.question("Operator id: ")).trim() || "unknown-operator";
  const notes = (await rl.question("What did you do? ")).trim();
  const actionsLine = (await rl.question("Structured actions (optional, comma-separated): ")).trim();
  const answer = (await rl.question("Resume automation? [Y/n] ")).trim().toLowerCase();
  await rl.close();

  const manualActions = actionsLine
    ? actionsLine.split(",").map((item) => item.trim()).filter(Boolean)
    : undefined;

  return {
    interventionId,
    operator,
    notes,
    ...(manualActions && manualActions.length > 0 ? { manualActions } : {}),
    action: answer === "n" ? "abort" : "resume",
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Unattended path: the operator console writes `resolution.json` into the
 * intervention directory. Same contract as the interactive prompt, so the
 * control-transfer model does not change with the UI.
 */
async function awaitOperatorConsole(
  dir: string,
  interventionId: string,
  options: EscalationOptions,
): Promise<OperatorReportedFields> {
  const signalPath = path.join(dir, "resolution.json");
  const deadline = Date.now() + options.waitTimeoutMs;

  await options.logger.log({
    type: "intervention_awaiting_operator",
    interventionId,
    signalPath,
    timeoutMs: options.waitTimeoutMs,
  });

  while (Date.now() < deadline) {
    try {
      const signal = await readJson<Partial<InterventionResolution>>(signalPath);
      return {
        interventionId,
        operator: signal.operator ?? "operator-console",
        notes: signal.notes ?? "",
        ...(Array.isArray(signal.manualActions) ? { manualActions: signal.manualActions } : {}),
        action: signal.action === "abort" ? "abort" : "resume",
        resolvedAt: new Date().toISOString(),
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
    }
  }

  return {
    interventionId,
    operator: "none",
    notes: "No operator responded before the intervention timeout.",
    action: "abort",
    resolvedAt: new Date().toISOString(),
  };
}
