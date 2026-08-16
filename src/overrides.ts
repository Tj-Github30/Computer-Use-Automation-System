import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
  type CapabilityOverride,
  type FlowStep,
} from "./types.js";

/**
 * Cross-tenant reuse.
 *
 * Hundreds of institutions run the same ~20 vendor products, configured and
 * branded differently. Re-recording every capability per tenant is
 * hundreds x 20 recordings and hundreds of places to fix the same bug.
 *
 * Instead one base capability is recorded against the stock product and each
 * tenant layers a sparse override patching only what actually differs. The base
 * stays the source of truth, so a fix to the recorded flow reaches every tenant
 * that did not explicitly override that part.
 */

export class OverrideMismatchError extends Error {}

function applyStepPatches(
  steps: FlowStep[],
  override: CapabilityOverride,
  applied: string[],
): FlowStep[] {
  return steps.map((step) => {
    const patch = override.stepPatches[step.id];
    if (!patch) {
      return step;
    }
    const changed = Object.keys(patch).filter(
      (key) => patch[key as keyof typeof patch] !== undefined,
    );
    applied.push(`patched ${step.id} (${changed.join(", ")})`);
    return { ...step, ...patch };
  });
}

function applyInsertions(
  steps: FlowStep[],
  override: CapabilityOverride,
  applied: string[],
): FlowStep[] {
  const result: FlowStep[] = [];
  for (const step of steps) {
    for (const insertion of override.insertSteps) {
      if (insertion.before === step.id) {
        result.push(insertion.step);
        applied.push(`inserted ${insertion.step.id} before ${step.id}`);
      }
    }
    result.push(step);
    for (const insertion of override.insertSteps) {
      if (insertion.after === step.id) {
        result.push(insertion.step);
        applied.push(`inserted ${insertion.step.id} after ${step.id}`);
      }
    }
  }
  return result;
}

/**
 * Applies one override to a base artifact and revalidates the result, so a
 * malformed tenant patch fails here rather than halfway through a live run.
 */
export function resolveForTenant(
  base: CapabilityArtifact,
  override: CapabilityOverride,
): CapabilityArtifact {
  if (override.appId !== base.target.appId) {
    throw new OverrideMismatchError(
      `Override "${override.overrideId}" targets app "${override.appId}" but the base capability is "${base.target.appId}".`,
    );
  }
  if (override.appVersion && override.appVersion !== base.target.appVersion) {
    throw new OverrideMismatchError(
      `Override "${override.overrideId}" targets ${override.appId}@${override.appVersion} but the base capability is @${base.target.appVersion}.`,
    );
  }

  const applied: string[] = [];

  let steps = applyStepPatches(base.steps, override, applied);
  if (override.removeSteps.length > 0) {
    steps = steps.filter((step) => {
      if (override.removeSteps.includes(step.id)) {
        applied.push(`removed ${step.id}`);
        return false;
      }
      return true;
    });
  }
  steps = applyInsertions(steps, override, applied);

  // Tenant rules replace base rules sharing a code, so a tenant can reclassify
  // a condition (a gateway that auto-renews sessions makes SESSION_EXPIRED
  // recoverable) without forking the capability.
  const outcomeByCode = new Map(base.outcomes.map((rule) => [rule.code, rule]));
  for (const rule of override.outcomes) {
    applied.push(
      outcomeByCode.has(rule.code) ? `replaced outcome ${rule.code}` : `added outcome ${rule.code}`,
    );
    outcomeByCode.set(rule.code, rule);
  }

  for (const [key, value] of Object.entries(override.target)) {
    if (value !== undefined) {
      applied.push(`target.${key}`);
    }
  }
  if (override.successCheckpoint) {
    applied.push("successCheckpoint");
  }

  const resolved: CapabilityArtifact = {
    ...base,
    target: {
      ...base.target,
      ...Object.fromEntries(
        Object.entries(override.target).filter(([, value]) => value !== undefined),
      ),
      tenantId: override.tenantId,
    },
    successCheckpoint: override.successCheckpoint ?? base.successCheckpoint,
    outcomes: [...outcomeByCode.values()],
    steps,
    provenance: {
      ...base.provenance,
      derivedFrom: {
        baseTenantId: base.target.tenantId,
        overrideId: override.overrideId,
        appliedPatches: applied,
      },
    },
  };

  return CapabilityArtifactSchema.parse(resolved);
}
