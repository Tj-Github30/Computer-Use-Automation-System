import path from "node:path";
import { BrowserSurface } from "./browser-surface.js";
import { detectCondition } from "./detectors.js";
import { escalateToHuman } from "./escalation.js";
import { ensureDir, nowStamp } from "./fs-utils.js";
import { RunLogger } from "./logger.js";
import {
  assertActionAllowed,
  assertUrlAllowed,
  PolicyViolationError,
  type PolicyConfig,
} from "./policy.js";
import { Redactor } from "./redaction.js";
import { gateRiskyStep } from "./risk-gate.js";
import { SessionControl } from "./session-control.js";
import { describeCandidate, type Surface } from "./surface.js";
import type {
  CapabilityArtifact,
  FlowStep,
  Observation,
  ReplayResult,
  RunInput,
  ValueType,
} from "./types.js";

const MAX_ESCALATIONS_PER_STEP = 1;

export type ReplayOptions = {
  artifact: CapabilityArtifact;
  inputs: RunInput;
  policy: PolicyConfig;
  evidenceRootDir: string;
  headless: boolean;
  interactive: boolean;
  escalationEnabled: boolean;
  escalationTimeoutMs: number;
  pollIntervalMs: number;
  takeoverPort?: number;
};

type StepFailure = {
  classification: ReplayResult["failure"] extends infer T
    ? T extends { classification: infer C }
      ? C
      : never
    : never;
  observed: string;
  expected?: string;
  conditionCode?: string;
};

function fillTemplate(template: string | undefined, inputs: RunInput): string {
  if (!template) {
    return "";
  }
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) =>
    String(inputs[key.trim()] ?? ""),
  );
}

function coerce(raw: string, type: ValueType): string | number | boolean {
  if (type === "number") {
    const numeric = Number(raw.replace(/[^0-9.\-]/g, ""));
    return Number.isNaN(numeric) ? raw : numeric;
  }
  if (type === "boolean") {
    return /^(true|yes|y|1)$/i.test(raw.trim());
  }
  return raw;
}

/** Rejects a bad invocation before touching the application. */
function validateInputs(
  artifact: CapabilityArtifact,
  inputs: RunInput,
): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  for (const [name, param] of Object.entries(artifact.inputs)) {
    const value = inputs[name];
    if (value === undefined || value === "") {
      if (param.required) {
        problems.push(`missing required input "${name}" (${param.description})`);
      }
      continue;
    }
    if (param.type === "number" && Number.isNaN(Number(value))) {
      problems.push(`input "${name}" must be a number, got "${String(value)}"`);
    }
    if (param.pattern && !new RegExp(param.pattern).test(String(value))) {
      problems.push(`input "${name}" does not match required pattern ${param.pattern}`);
    }
  }
  const unknown = Object.keys(inputs).filter((key) => !artifact.inputs[key]);
  if (unknown.length > 0) {
    problems.push(`unknown input(s) not declared by the capability: ${unknown.join(", ")}`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const { artifact } = options;
  const runId = `replay-${nowStamp()}`;
  const evidenceDir = path.join(options.evidenceRootDir, runId);
  await ensureDir(evidenceDir);

  const startedAt = new Date();
  const redactor = new Redactor();
  redactor.declareSensitiveKeys([
    ...Object.entries(artifact.inputs).filter(([, p]) => p.sensitive).map(([k]) => k),
    ...Object.entries(artifact.outputs).filter(([, o]) => o.sensitive).map(([k]) => k),
  ]);
  for (const [key, value] of Object.entries(options.inputs)) {
    if (artifact.inputs[key]?.sensitive) {
      redactor.declareSensitiveValue(String(value));
    }
  }

  const logger = new RunLogger(evidenceDir, redactor);
  const control = new SessionControl(logger, runId);
  const outputs: Record<string, unknown> = {};
  const recoveries: ReplayResult["recoveries"] = [];
  let escalation: ReplayResult["escalation"];

  const finish = (
    partial: Pick<ReplayResult, "status"> &
      Partial<Pick<ReplayResult, "businessOutcome" | "failure">>,
  ): ReplayResult => {
    const finishedAt = new Date();
    return {
      status: partial.status,
      capability: {
        id: artifact.capability.id,
        name: artifact.capability.name,
        revision: artifact.capability.revision,
      },
      outputs,
      businessOutcome: partial.businessOutcome,
      failure: partial.failure,
      recoveries,
      escalation,
      controlOwnerAtEnd: control.current(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      evidenceDir,
    };
  };

  const validation = validateInputs(artifact, options.inputs);
  if (!validation.ok) {
    await logger.log({ type: "input_validation_failed", problems: validation.problems });
    return finish({
      status: "failure",
      failure: {
        classification: "input_invalid",
        observed: validation.problems.join("; "),
        expected: `inputs matching capability contract: ${Object.keys(artifact.inputs).join(", ")}`,
      },
    });
  }

  const surface: Surface = new BrowserSurface({
    headless: options.headless,
    scrubText: (text) => redactor.redactText(text),
    takeoverPort: options.takeoverPort,
  });

  await surface.start();
  try {
    assertUrlAllowed(artifact.target.entryUrl, options.policy);
    await surface.goto(artifact.target.entryUrl);

    await logger.log({
      type: "run_started",
      mode: "replay",
      capabilityId: artifact.capability.id,
      capabilityName: artifact.capability.name,
      revision: artifact.capability.revision,
      status: artifact.capability.status,
      inputs: options.inputs,
      controlOwner: control.current(),
    });

    for (const step of artifact.steps) {
      const stepResult = await executeStep(step);

      if (stepResult.kind === "business") {
        await surface.captureScreenshot(evidenceDir, `${step.id}-business-outcome`);
        const result = finish({
          status: "business_outcome",
          businessOutcome: {
            code: stepResult.code,
            description: stepResult.description,
            detectedAtStep: step.id,
          },
        });
        await logger.log({ type: "business_outcome", result });
        return result;
      }

      if (stepResult.kind === "failure") {
        await surface.captureScreenshot(evidenceDir, `${step.id}-failure`);
        await surface.captureSnapshot(evidenceDir, `${step.id}-failure`);
        const result = finish({
          status: "failure",
          failure: {
            classification: stepResult.failure.classification,
            stepId: step.id,
            stepIntent: step.intent,
            expected: stepResult.failure.expected,
            observed: stepResult.failure.observed,
            conditionCode: stepResult.failure.conditionCode,
          },
        });
        await logger.log({ type: "step_failed", result });
        return result;
      }

      if (stepResult.kind === "finished") {
        break;
      }
    }

    const checkpointOk = await verifyCheckpoint();
    if (!checkpointOk.ok) {
      await surface.captureScreenshot(evidenceDir, "checkpoint-failure");
      await surface.captureSnapshot(evidenceDir, "checkpoint-failure");
      const result = finish({
        status: "failure",
        failure: {
          classification: "checkpoint_failed",
          expected: `${artifact.successCheckpoint.type}: ${artifact.successCheckpoint.value}`,
          observed: checkpointOk.observed,
        },
      });
      await logger.log({ type: "checkpoint_failed", result });
      return result;
    }

    await surface.captureScreenshot(evidenceDir, "success");
    const result = finish({ status: "success" });
    await logger.log({ type: "run_completed", result });
    return result;
  } catch (error) {
    const observed = error instanceof Error ? error.message : String(error);
    const result = finish({
      status: "failure",
      failure: {
        classification:
          error instanceof PolicyViolationError ? "policy_violation" : "hard_failure",
        observed,
      },
    });
    await logger.log({ type: "run_aborted", result });
    return result;
  } finally {
    await surface.close();
  }

  /**
   * Runs one recorded step, re-attempting it while declared recoverable
   * conditions keep resolving, and translating anything else into a business
   * outcome or a hard failure.
   */
  async function executeStep(step: FlowStep): Promise<
    | { kind: "done" }
    | { kind: "finished" }
    | { kind: "business"; code: string; description: string }
    | { kind: "failure"; failure: StepFailure }
  > {
    if (step.action === "finish") {
      return { kind: "finished" };
    }

    try {
      assertActionAllowed(step.action, options.policy);
    } catch (error) {
      return {
        kind: "failure",
        failure: {
          classification: "policy_violation",
          observed: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const gate = await gateRiskyStep({
      risk: step.risk,
      policy: options.policy,
      logger,
      control,
      surface,
      evidenceDir,
      capability: artifact.capability.name,
      goal: artifact.provenance.goal,
      stepId: step.id,
      stepIntent: step.intent ?? step.action,
      interactive: options.interactive,
      sessionVisible: !options.headless,
      escalationTimeoutMs: options.escalationTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    if (!gate.allowed) {
      return {
        kind: "failure",
        failure: {
          classification: "policy_violation",
          observed: gate.reason ?? "Risk gate refused the step",
        },
      };
    }

    let attempt = 0;
    let escalations = 0;
    const maxAttempts = 4;

    while (attempt < maxAttempts) {
      attempt += 1;
      let actionError: Error | undefined;

      try {
        control.assertAutomationMayAct();
        await performAction(step);
      } catch (error) {
        actionError = error instanceof Error ? error : new Error(String(error));
      }

      const observation = await surface.observe();
      const match = detectCondition(observation, artifact.outcomes, actionError);

      if (match) {
        await logger.log({
          type: "condition_detected",
          stepId: step.id,
          code: match.rule.code,
          kind: match.rule.kind,
          evidence: match.evidence,
          attempt,
        });

        if (match.rule.kind === "business") {
          return {
            kind: "business",
            code: match.rule.code,
            description: match.rule.description,
          };
        }

        if (match.rule.kind === "recoverable") {
          const recovery = match.rule.recovery ?? {
            action: "wait_and_retry" as const,
            maxAttempts: 2,
            waitMs: 1000,
          };
          const used = recoveries.filter(
            (item) => item.stepId === step.id && item.code === match.rule.code,
          ).length;

          if (used >= recovery.maxAttempts) {
            return {
              kind: "failure",
              failure: {
                classification: "recoverable_exhausted",
                conditionCode: match.rule.code,
                expected: step.expectedText ?? step.target?.description,
                observed: `${match.rule.description} did not clear after ${used} recovery attempts (${match.evidence})`,
              },
            };
          }

          recoveries.push({
            stepId: step.id,
            code: match.rule.code,
            action: recovery.action,
            attempt: used + 1,
          });
          await applyRecovery(recovery.action, recovery.waitMs);
          await logger.log({
            type: "recovery_applied",
            stepId: step.id,
            code: match.rule.code,
            action: recovery.action,
            attempt: used + 1,
          });

          // The dialog was the whole problem and the action already landed.
          if (match.rule.code === "UNEXPECTED_DIALOG" && !actionError) {
            return { kind: "done" };
          }
          continue;
        }

        // Hard condition: a person may be able to clear it on the live session.
        if (
          match.rule.escalate &&
          options.escalationEnabled &&
          escalations < MAX_ESCALATIONS_PER_STEP
        ) {
          escalations += 1;
          const resolution = await escalateToHuman({
            logger,
            control,
            surface,
            evidenceDir,
            capability: artifact.capability.name,
            goal: artifact.provenance.goal,
            reason: `${match.rule.code}: ${match.rule.description}`,
            conditionCode: match.rule.code,
            stepId: step.id,
            stepIntent: step.intent ?? step.action,
            interactive: options.interactive,
            sessionVisible: !options.headless,
            waitTimeoutMs: options.escalationTimeoutMs,
            pollIntervalMs: options.pollIntervalMs,
          });
          escalation = {
            requested: true,
            resolved: resolution.action === "resume",
            reason: match.rule.code,
            operator: resolution.operator,
          };
          if (resolution.action === "resume") {
            continue;
          }
        }

        // Distinguish "we never got help" from "a human took control and the
        // condition survived it" — the second is a much stronger signal that the
        // capability, not the run, is what needs attention.
        const persistedAfterHandoff = escalation?.resolved === true;
        return {
          kind: "failure",
          failure: {
            classification: "hard_failure",
            conditionCode: match.rule.code,
            expected: step.expectedText ?? step.target?.description,
            observed: persistedAfterHandoff
              ? `${match.rule.description} — still present after operator ${escalation?.operator ?? "unknown"} handed control back (${match.evidence})`
              : `${match.rule.description} (${match.evidence})`,
          },
        };
      }

      if (actionError) {
        if (step.optional) {
          await logger.log({
            type: "optional_step_skipped",
            stepId: step.id,
            observed: actionError.message,
          });
          return { kind: "done" };
        }
        return {
          kind: "failure",
          failure: {
            classification: "hard_failure",
            expected: step.target
              ? `${step.target.description} via ${describeCandidate(step.target.primary)}`
              : step.expectedText,
            observed: actionError.message,
          },
        };
      }

      await logger.log({
        type: "step_completed",
        stepId: step.id,
        action: step.action,
        intent: step.intent,
        url: observation.url,
        attempt,
      });
      return { kind: "done" };
    }

    return {
      kind: "failure",
      failure: {
        classification: "recoverable_exhausted",
        observed: `Step did not settle after ${maxAttempts} attempts`,
      },
    };
  }

  async function performAction(step: FlowStep): Promise<void> {
    switch (step.action) {
      case "goto": {
        const url = fillTemplate(step.valueTemplate, options.inputs) || artifact.target.entryUrl;
        assertUrlAllowed(url, options.policy);
        await surface.goto(url);
        return;
      }
      case "click": {
        if (!step.target) {
          throw new Error(`Step ${step.id} is a click with no recorded target`);
        }
        const used = await surface.click(step.target, step.timeoutMs);
        if (used !== step.target.primary) {
          await logger.log({
            type: "locator_fallback_used",
            stepId: step.id,
            primary: describeCandidate(step.target.primary),
            used: describeCandidate(used),
          });
        }
        return;
      }
      case "type": {
        if (!step.target) {
          throw new Error(`Step ${step.id} is a type with no recorded target`);
        }
        await surface.type(step.target, fillTemplate(step.valueTemplate, options.inputs), step.timeoutMs);
        return;
      }
      case "wait_for_text": {
        if (!step.expectedText) {
          throw new Error(`Step ${step.id} is a wait with no expected text`);
        }
        await surface.waitForText(step.expectedText, step.timeoutMs);
        return;
      }
      case "extract_text": {
        if (!step.target || !step.outputKey) {
          throw new Error(`Step ${step.id} is an extract with no target or output key`);
        }
        const raw = await surface.readText(step.target, step.timeoutMs);
        const declared = artifact.outputs[step.outputKey];
        if (declared?.sensitive) {
          redactor.declareSensitiveValue(raw);
        }
        outputs[step.outputKey] = coerce(raw, declared?.type ?? "string");
        await logger.log({
          type: "output_captured",
          stepId: step.id,
          outputKey: step.outputKey,
          value: outputs[step.outputKey],
        });
        return;
      }
      case "escalate": {
        const resolution = await escalateToHuman({
          logger,
          control,
          surface,
          evidenceDir,
          capability: artifact.capability.name,
          goal: artifact.provenance.goal,
          reason: step.intent ?? "Recorded escalation step",
          conditionCode: "RECORDED_ESCALATION",
          stepId: step.id,
          stepIntent: step.intent ?? step.action,
          interactive: options.interactive,
          sessionVisible: !options.headless,
          waitTimeoutMs: options.escalationTimeoutMs,
          pollIntervalMs: options.pollIntervalMs,
        });
        escalation = {
          requested: true,
          resolved: resolution.action === "resume",
          reason: "RECORDED_ESCALATION",
          operator: resolution.operator,
        };
        if (resolution.action === "abort") {
          throw new Error(`Operator ${resolution.operator} aborted the run`);
        }
        return;
      }
      default:
        return;
    }
  }

  async function applyRecovery(
    action: "dismiss_dialog" | "wait_and_retry" | "reload_and_retry",
    waitMs: number,
  ): Promise<void> {
    if (action === "dismiss_dialog") {
      surface.drainDialogs();
      return;
    }
    if (action === "reload_and_retry") {
      await surface.reload();
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  async function verifyCheckpoint(): Promise<{ ok: boolean; observed: string }> {
    const checkpoint = artifact.successCheckpoint;
    const deadline = Date.now() + checkpoint.timeoutMs;
    let observation: Observation = await surface.observe();

    while (Date.now() < deadline) {
      const holds =
        checkpoint.type === "url_contains"
          ? observation.url.includes(checkpoint.value)
          : checkpoint.type === "element_visible" && checkpoint.target
            ? await surface.isVisible(checkpoint.target, 1500)
            : observation.text.includes(checkpoint.value);

      if (holds) {
        return { ok: true, observed: observation.url };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      observation = await surface.observe();
    }

    return {
      ok: false,
      observed: `checkpoint absent at ${observation.url}; page showed: ${observation.text.slice(0, 200)}`,
    };
  }
}
