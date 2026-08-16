import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { BrowserSurface } from "./browser-surface.js";
import { escalateToHuman } from "./escalation.js";
import { ensureDir, nowStamp, writeJson } from "./fs-utils.js";
import type { DecisionModel } from "./llm.js";
import { RunLogger } from "./logger.js";
import { assertActionAllowed, assertUrlAllowed, classifyRisk, PolicyViolationError, type PolicyConfig } from "./policy.js";
import { Redactor } from "./redaction.js";
import { gateRiskyStep } from "./risk-gate.js";
import { SessionControl } from "./session-control.js";
import { describeCandidate, type Surface } from "./surface.js";
import {
  SCHEMA_VERSION,
  type AgentDecision,
  type CapabilityArtifact,
  type CapabilitySpec,
  type Checkpoint,
  type FlowStep,
  type InputParam,
  type OutputField,
  type RunInput,
} from "./types.js";

/** Consecutive identical decisions that mean the model is going in circles. */
const DEAD_END_REPEAT_THRESHOLD = 3;
const MAX_CONSECUTIVE_MODEL_ERRORS = 3;

export type DiscoveryOptions = {
  goal: string;
  entryUrl: string;
  spec: CapabilitySpec;
  model: DecisionModel;
  inputs: RunInput;
  policy: PolicyConfig;
  maxSteps: number;
  timeoutMs: number;
  headless: boolean;
  evidenceRootDir: string;
  artifactRootDir: string;
  interactive: boolean;
  escalationTimeoutMs: number;
  pollIntervalMs: number;
  takeoverPort?: number;
};

export type DiscoveryResult = {
  status: "recorded" | "failed";
  runId: string;
  evidenceDir: string;
  artifactPath?: string;
  artifact?: CapabilityArtifact;
  failure?: { reason: string; detail: string };
};

function decisionSignature(decision: AgentDecision): string {
  return [
    decision.action,
    decision.target?.primary.strategy,
    decision.target?.primary.value,
    decision.value,
  ]
    .filter(Boolean)
    .join("|");
}

/**
 * Rewrites literals the model typed back into `{{param}}` references so the
 * artifact stays parameterised and never carries a real record identifier or a
 * caller-supplied secret.
 */
export function parameterize(
  literal: string | undefined,
  inputs: RunInput,
): { template?: string; usedParams: string[] } {
  if (literal === undefined) {
    return { usedParams: [] };
  }
  let template = literal;
  const usedParams: string[] = [];
  const byLongest = Object.entries(inputs).sort(
    ([, a], [, b]) => String(b).length - String(a).length,
  );
  for (const [key, value] of byLongest) {
    const asString = String(value);
    if (asString.length > 0 && template.includes(asString)) {
      template = template.split(asString).join(`{{${key}}}`);
      usedParams.push(key);
    }
  }
  return { template, usedParams };
}

/**
 * Models happily propose locators like `text="$4,230.91"` after reading a record.
 * Those both leak regulated data into a stored artifact and only ever match the
 * one member it was recorded against, so they are stripped at the boundary
 * rather than trusted away in the prompt.
 */
export function stripSensitiveLocators(
  steps: FlowStep[],
  literals: string[],
): { steps: FlowStep[]; removed: Array<{ stepId: string; candidate: string }>; blocked: string[] } {
  const usable = literals.filter((literal) => literal.length >= 3);
  const taints = (value: string): boolean => usable.some((literal) => value.includes(literal));

  const removed: Array<{ stepId: string; candidate: string }> = [];
  const blocked: string[] = [];

  const sanitized = steps.map((step) => {
    if (!step.target) {
      return step;
    }
    const candidates = [step.target.primary, ...step.target.fallbacks];
    const clean = candidates.filter((candidate) => {
      if (taints(candidate.value)) {
        removed.push({ stepId: step.id, candidate: describeCandidate(candidate) });
        return false;
      }
      return true;
    });

    if (clean.length === 0) {
      blocked.push(step.id);
      return step;
    }
    return {
      ...step,
      target: { ...step.target, primary: clean[0], fallbacks: clean.slice(1) },
    };
  });

  return { steps: sanitized, removed, blocked };
}

function referencedParams(steps: FlowStep[]): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    for (const match of (step.valueTemplate ?? "").matchAll(/\{\{([^}]+)\}\}/g)) {
      found.add(match[1].trim());
    }
  }
  return [...found];
}

export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const runId = `discovery-${nowStamp()}`;
  const evidenceDir = path.join(options.evidenceRootDir, runId);
  await ensureDir(evidenceDir);

  const redactor = new Redactor();
  redactor.declareSensitiveKeys([
    ...Object.entries(options.spec.inputs).filter(([, p]) => p.sensitive).map(([k]) => k),
    ...Object.entries(options.spec.outputs).filter(([, o]) => o.sensitive).map(([k]) => k),
  ]);
  for (const [key, value] of Object.entries(options.inputs)) {
    if (options.spec.inputs[key]?.sensitive) {
      redactor.declareSensitiveValue(String(value));
    }
  }

  const logger = new RunLogger(evidenceDir, redactor);
  const control = new SessionControl(logger, runId);
  const surface: Surface = new BrowserSurface({
    headless: options.headless,
    policy: options.policy,
    scrubText: (text) => redactor.redactText(text),
    takeoverPort: options.takeoverPort,
  });

  const steps: FlowStep[] = [];
  const discoveredOutputs = new Map<string, string>();
  const history: DecisionContextHistory = [];
  const startedAt = Date.now();

  let checkpoint: Checkpoint | undefined = options.spec.successCheckpoint;
  let repeatCount = 0;
  let lastSignature = "";
  let modelErrors = 0;

  const fail = async (reason: string, detail: string): Promise<DiscoveryResult> => {
    await logger.log({ type: "discovery_failed", reason, detail });
    return { status: "failed", runId, evidenceDir, failure: { reason, detail } };
  };

  await surface.start();
  try {
    assertUrlAllowed(options.entryUrl, options.policy);
    await surface.goto(options.entryUrl);

    await logger.log({
      type: "run_started",
      mode: "discovery",
      goal: options.goal,
      entryUrl: options.entryUrl,
      capability: options.spec.name,
      model: options.model.name(),
      inputs: options.inputs,
      controlOwner: control.current(),
    });
    await surface.captureScreenshot(evidenceDir, "00-entry");

    let finished = false;

    for (let index = 0; index < options.maxSteps && !finished; index += 1) {
      if (Date.now() - startedAt > options.timeoutMs) {
        await surface.captureScreenshot(evidenceDir, "timeout");
        await surface.captureSnapshot(evidenceDir, "timeout");
        return await fail("timeout", `Discovery exceeded ${options.timeoutMs}ms`);
      }

      control.assertAutomationMayAct();
      const observation = await surface.observe();
      const stepId = `step_${String(index + 1).padStart(2, "0")}`;

      let decision: AgentDecision;
      try {
        decision = await options.model.nextDecision({
          goal: options.goal,
          observation,
          history,
          inputs: options.inputs,
          availableInputKeys: Object.keys(options.inputs),
        });
        modelErrors = 0;
      } catch (error) {
        modelErrors += 1;
        const detail = error instanceof Error ? error.message : String(error);
        await logger.log({ type: "model_error", stepId, detail, attempt: modelErrors });
        if (modelErrors >= MAX_CONSECUTIVE_MODEL_ERRORS) {
          return await fail("model_unusable", detail);
        }
        continue;
      }

      // Dead end: the model keeps proposing the same thing, so the surface is
      // not responding the way it expects.
      const signature = decisionSignature(decision);
      repeatCount = signature === lastSignature ? repeatCount + 1 : 0;
      lastSignature = signature;
      if (repeatCount >= DEAD_END_REPEAT_THRESHOLD - 1) {
        await surface.captureScreenshot(evidenceDir, `${stepId}-dead-end`);
        await escalateToHuman({
          logger,
          control,
          surface,
          evidenceDir,
          capability: options.spec.name,
          goal: options.goal,
          reason: `Discovery stalled: repeated "${signature}" ${DEAD_END_REPEAT_THRESHOLD} times`,
          conditionCode: "DISCOVERY_DEAD_END",
          stepId,
          stepIntent: decision.rationale,
          interactive: options.interactive,
          sessionVisible: !options.headless,
          waitTimeoutMs: options.escalationTimeoutMs,
          pollIntervalMs: options.pollIntervalMs,
        });
        return await fail("dead_end", `Model repeated the same action: ${signature}`);
      }

      assertActionAllowed(decision.action, options.policy);
      const risk = classifyRisk(decision.action, options.policy, decision.target, decision.rationale);
      const { template, usedParams } = parameterize(decision.value, options.inputs);

      await logger.log({
        type: "decision",
        stepId,
        action: decision.action,
        rationale: decision.rationale,
        target: decision.target?.description,
        locator: decision.target ? describeCandidate(decision.target.primary) : undefined,
        risk,
        usedParams,
        url: observation.url,
      });

      const gate = await gateRiskyStep({
        risk,
        policy: options.policy,
        logger,
        control,
        surface,
        evidenceDir,
        capability: options.spec.name,
        goal: options.goal,
        stepId,
        stepIntent: decision.rationale,
        interactive: options.interactive,
        sessionVisible: !options.headless,
        escalationTimeoutMs: options.escalationTimeoutMs,
        pollIntervalMs: options.pollIntervalMs,
      });
      if (!gate.allowed) {
        return await fail("blocked_by_policy", gate.reason ?? "Risk gate refused the step");
      }

      history.push({
        action: decision.action,
        rationale: decision.rationale,
        target: decision.target?.description,
      });

      try {
        switch (decision.action) {
          case "goto": {
            const url = template ?? options.entryUrl;
            assertUrlAllowed(url, options.policy);
            await surface.goto(url);
            steps.push(baseStep(stepId, decision, risk, { valueTemplate: template }));
            break;
          }
          case "click": {
            if (!decision.target) {
              return await fail("invalid_decision", "click without a target");
            }
            await surface.click(decision.target, 10_000);
            assertUrlAllowed(surface.currentUrl(), options.policy);
            steps.push(baseStep(stepId, decision, risk));
            break;
          }
          case "type": {
            if (!decision.target) {
              return await fail("invalid_decision", "type without a target");
            }
            await surface.type(decision.target, decision.value ?? "", 10_000);
            if (decision.value && usedParams.length === 0) {
              await logger.log({
                type: "unparameterized_literal",
                stepId,
                note: "Typed value did not match any declared input; artifact will hard-code it.",
              });
            }
            steps.push(baseStep(stepId, decision, risk, { valueTemplate: template }));
            break;
          }
          case "wait_for_text": {
            if (!decision.expectedText) {
              return await fail("invalid_decision", "wait_for_text without expectedText");
            }
            await surface.waitForText(decision.expectedText, 10_000);
            steps.push(baseStep(stepId, decision, risk));
            break;
          }
          case "extract_text": {
            if (!decision.target || !decision.outputKey) {
              return await fail("invalid_decision", "extract_text without target or outputKey");
            }
            const value = await surface.readText(decision.target, 10_000);
            if (options.spec.outputs[decision.outputKey]?.sensitive) {
              redactor.declareSensitiveValue(value);
            }
            discoveredOutputs.set(decision.outputKey, value);
            steps.push(baseStep(stepId, decision, risk));
            await logger.log({
              type: "output_extracted",
              stepId,
              outputKey: decision.outputKey,
              value,
            });
            break;
          }
          case "escalate": {
            const resolution = await escalateToHuman({
              logger,
              control,
              surface,
              evidenceDir,
              capability: options.spec.name,
              goal: options.goal,
              reason: decision.escalateReason ?? "Model requested human help",
              conditionCode: "MODEL_REQUESTED_ESCALATION",
              stepId,
              stepIntent: decision.rationale,
              interactive: options.interactive,
              sessionVisible: !options.headless,
              waitTimeoutMs: options.escalationTimeoutMs,
              pollIntervalMs: options.pollIntervalMs,
            });
            if (resolution.action === "abort") {
              return await fail("operator_aborted", resolution.notes || "Operator aborted the run");
            }
            break;
          }
          case "finish": {
            if (!checkpoint && decision.checkpointText) {
              checkpoint = {
                type: "text_present",
                value: decision.checkpointText,
                timeoutMs: 10_000,
              };
            }
            finished = true;
            break;
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await surface.captureScreenshot(evidenceDir, `${stepId}-error`);
        await surface.captureSnapshot(evidenceDir, `${stepId}-error`);
        if (error instanceof PolicyViolationError) {
          return await fail("blocked_by_policy", `${stepId} (${decision.action}): ${detail}`);
        }
        return await fail("action_failed", `${stepId} (${decision.action}): ${detail}`);
      }
    }

    if (!finished) {
      await surface.captureScreenshot(evidenceDir, "max-steps");
      return await fail("max_steps", `Goal not reached within ${options.maxSteps} steps`);
    }

    if (!checkpoint) {
      return await fail(
        "no_checkpoint",
        "Run finished without a success condition; nothing can be verified on replay.",
      );
    }

    // A run only becomes a capability if the success condition actually holds.
    const finalObservation = await surface.observe();
    const checkpointHolds =
      checkpoint.type === "url_contains"
        ? finalObservation.url.includes(checkpoint.value)
        : checkpoint.type === "element_visible" && checkpoint.target
          ? await surface.isVisible(checkpoint.target, checkpoint.timeoutMs)
          : finalObservation.text.includes(checkpoint.value);

    if (!checkpointHolds) {
      await surface.captureScreenshot(evidenceDir, "checkpoint-failed");
      await surface.captureSnapshot(evidenceDir, "checkpoint-failed");
      return await fail(
        "checkpoint_not_met",
        `Model declared success but checkpoint (${checkpoint.type}: ${checkpoint.value}) did not hold`,
      );
    }

    await surface.captureScreenshot(evidenceDir, "99-success");
    await surface.captureSnapshot(evidenceDir, "99-success");

    const sensitiveLiterals = [
      ...[...discoveredOutputs.entries()]
        .filter(([key]) => options.spec.outputs[key]?.sensitive)
        .map(([, value]) => value),
      ...Object.entries(options.inputs)
        .filter(([key]) => options.spec.inputs[key]?.sensitive)
        .map(([, value]) => String(value)),
    ];
    const scrub = stripSensitiveLocators(steps, sensitiveLiterals);
    if (scrub.removed.length > 0) {
      await logger.log({
        type: "sensitive_locator_stripped",
        removed: scrub.removed.map((item) => item.stepId),
        note: "Locator candidates derived from record data were removed before persisting.",
      });
    }
    if (scrub.blocked.length > 0) {
      return await fail(
        "unsafe_locators",
        `Steps ${scrub.blocked.join(", ")} could only be located by record data; refusing to persist.`,
      );
    }
    const safeSteps = scrub.steps;

    const inputs = resolveInputs(options.spec, safeSteps, options.inputs);
    const missing = referencedParams(safeSteps).filter((param) => !inputs[param]);
    if (missing.length > 0) {
      return await fail(
        "undeclared_input",
        `Steps reference undeclared inputs: ${missing.join(", ")}`,
      );
    }

    const artifact: CapabilityArtifact = {
      schemaVersion: SCHEMA_VERSION,
      capability: {
        id: uuidv4(),
        name: options.spec.name,
        revision: 1,
        status: "draft",
        description: options.spec.description,
      },
      target: {
        surface: "web",
        entryUrl: options.entryUrl,
        appId: options.spec.appId,
        appVersion: options.spec.appVersion,
        tenantId: options.spec.tenantId,
        allowedDomains: options.policy.allowedDomains,
        allowedPathPrefixes: options.policy.allowedPathPrefixes,
      },
      inputs,
      outputs: resolveOutputs(options.spec, [...discoveredOutputs.keys()]),
      successCheckpoint: checkpoint,
      outcomes: options.spec.outcomes,
      steps: safeSteps,
      provenance: {
        createdAt: new Date().toISOString(),
        createdBy: "discovery-loop",
        goal: options.goal,
        model: options.model.name(),
        discoveryRunId: runId,
      },
    };

    const artifactPath = path.join(
      options.artifactRootDir,
      `${artifact.capability.name}.v${artifact.capability.revision}.json`,
    );
    await writeJson(artifactPath, artifact);
    await logger.log({
      type: "artifact_recorded",
      artifactPath,
      capabilityId: artifact.capability.id,
      stepCount: safeSteps.length,
      outputs: Object.keys(artifact.outputs),
    });
    await logger.log({ type: "run_completed", status: "recorded" });

    return { status: "recorded", runId, evidenceDir, artifactPath, artifact };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return await fail("unhandled_error", detail);
  } finally {
    await surface.close();
  }
}

type DecisionContextHistory = Array<{ action: string; rationale: string; target?: string }>;

function baseStep(
  id: string,
  decision: AgentDecision,
  risk: FlowStep["risk"],
  overrides: Partial<FlowStep> = {},
): FlowStep {
  return {
    id,
    action: decision.action,
    target: decision.target,
    expectedText: decision.expectedText,
    outputKey: decision.outputKey,
    intent: decision.rationale,
    risk,
    optional: false,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function resolveInputs(
  spec: CapabilitySpec,
  steps: FlowStep[],
  runInputs: RunInput,
): Record<string, InputParam> {
  const inputs: Record<string, InputParam> = { ...spec.inputs };
  for (const param of referencedParams(steps)) {
    if (!inputs[param]) {
      inputs[param] = {
        type: "string",
        required: true,
        description: `Discovered parameter "${param}" supplied during recording.`,
        example: runInputs[param] !== undefined ? String(runInputs[param]) : undefined,
        sensitive: false,
      };
    }
  }
  return inputs;
}

function resolveOutputs(
  spec: CapabilitySpec,
  discoveredKeys: string[],
): Record<string, OutputField> {
  const outputs: Record<string, OutputField> = {};
  for (const key of discoveredKeys) {
    outputs[key] = spec.outputs[key] ?? {
      type: "string",
      description: `Value read from the surface during recording ("${key}").`,
      sensitive: false,
    };
  }
  return outputs;
}
