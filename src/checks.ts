/**
 * Focused checks for the safety-critical pure functions, so the guarantees the
 * write-up claims are verified rather than asserted. Run with `npm run checks`.
 */
import { detectCondition } from "./detectors.js";
import { parameterize, stripSensitiveLocators } from "./discovery.js";
import { OverrideMismatchError, resolveForTenant } from "./overrides.js";
import { classifyRisk, defaultPolicy, assertUrlAllowed, PolicyViolationError } from "./policy.js";
import { Redactor } from "./redaction.js";
import type { CapabilityArtifact, CapabilityOverride, FlowStep, Observation } from "./types.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function observation(partial: Partial<Observation>): Observation {
  return {
    url: "http://localhost:3000/",
    title: "",
    text: "",
    ariaSnapshot: "",
    dialogs: [],
    ...partial,
  };
}

console.log("\nAllowlist");
{
  check("allows an allowlisted host", (() => {
    try {
      assertUrlAllowed("http://localhost:3000/members", defaultPolicy);
      return true;
    } catch {
      return false;
    }
  })());

  const blocks = (url: string, policy = defaultPolicy): boolean => {
    try {
      assertUrlAllowed(url, policy);
      return false;
    } catch (error) {
      return error instanceof PolicyViolationError;
    }
  };
  check("blocks an off-allowlist domain", blocks("https://evil.example.com/"));
  check("blocks a disallowed protocol", blocks("file:///etc/passwd"));
  check(
    "blocks a route outside the prefix allowlist",
    blocks("http://localhost:3000/admin", {
      ...defaultPolicy,
      allowedPathPrefixes: ["/members"],
    }),
  );
}

console.log("\nRisk classification");
{
  const target = (description: string) => ({
    description,
    primary: { strategy: "role" as const, value: description, role: "button" },
    fallbacks: [],
  });
  check("reads are safe", classifyRisk("extract_text", defaultPolicy) === "safe");
  check("data entry is risky", classifyRisk("type", defaultPolicy, target("Member ID")) === "risky");
  check(
    "a lookup button is not irreversible",
    classifyRisk("click", defaultPolicy, target("Search")) === "safe",
  );
  check(
    "money movement is irreversible",
    classifyRisk("click", defaultPolicy, target("Transfer funds")) === "irreversible",
  );
  check(
    "deletion is irreversible",
    classifyRisk("click", defaultPolicy, target("Delete member record")) === "irreversible",
  );
}

console.log("\nRedaction");
{
  const redactor = new Redactor();
  redactor.declareSensitiveKeys(["savingsBalance"]);
  redactor.declareSensitiveValue("$4,230.91");

  const redacted = redactor.redact({
    outputKey: "savingsBalance",
    value: "$4,230.91",
    password: "hunter2000",
    note: "balance shown was $4,230.91 on screen",
  }) as Record<string, string>;

  check("masks a declared sensitive key", !redacted.value.includes("4,230.91"));
  check("masks a secret key", !redacted.password.includes("hunter2000"));
  check(
    "scrubs an observed sensitive literal from free text",
    !redacted.note.includes("4,230.91"),
    redacted.note,
  );
  check(
    "scrubs sensitive literals from a DOM snapshot",
    !redactor.redactText("<td>$4,230.91</td>").includes("4,230.91"),
  );
  check(
    "redacts an SSN by shape even when undeclared",
    redactor.redactText("ssn 123-45-6789 on file").includes("[REDACTED_SSN]"),
  );
}

console.log("\nArtifact hygiene");
{
  check("a typed literal becomes a parameter reference", (() => {
    const { template, usedParams } = parameterize("1001", { memberId: "1001" });
    return template === "{{memberId}}" && usedParams.includes("memberId");
  })());
  check(
    "a literal embedded in a longer value is still parameterised",
    parameterize("/members/1001/detail", { memberId: "1001" }).template ===
      "/members/{{memberId}}/detail",
  );
  check(
    "an unrelated literal is left alone",
    parameterize("Search", { memberId: "1001" }).template === "Search",
  );

  const step = (id: string, primary: string, fallbacks: string[]): FlowStep => ({
    id,
    action: "extract_text",
    target: {
      description: "Savings balance",
      primary: { strategy: "xpath", value: primary },
      fallbacks: fallbacks.map((value) => ({ strategy: "text" as const, value })),
    },
    risk: "safe",
    optional: false,
    timeoutMs: 10_000,
  });

  // The exact shape a live Gemini run produced: a real balance as a fallback locator.
  const tainted = stripSensitiveLocators(
    [step("step_04", "//tr[td[contains(text(),'Savings Balance')]]/td[2]", ["$4,230.91"])],
    ["$4,230.91"],
  );
  check("strips a locator built from record data", tainted.removed.length === 1);
  check(
    "keeps the structural locator as primary",
    tainted.steps[0].target?.primary.value.startsWith("//tr") === true &&
      tainted.steps[0].target?.fallbacks.length === 0,
  );
  check("nothing sensitive survives in the artifact", !JSON.stringify(tainted.steps).includes("4,230.91"));

  const promoted = stripSensitiveLocators(
    [step("step_04", "$4,230.91", ["//tr[td[contains(text(),'Savings Balance')]]/td[2]"])],
    ["$4,230.91"],
  );
  check(
    "promotes a clean fallback when the primary is tainted",
    promoted.steps[0].target?.primary.value.startsWith("//tr") === true &&
      promoted.blocked.length === 0,
  );

  const hopeless = stripSensitiveLocators([step("step_04", "$4,230.91", ["$4,230.91"])], [
    "$4,230.91",
  ]);
  check(
    "refuses to record a step locatable only by record data",
    hopeless.blocked.includes("step_04"),
  );
}

console.log("\nCondition detection");
{
  const declared = [
    {
      code: "MEMBER_NOT_FOUND",
      kind: "business" as const,
      description: "No such member",
      detect: { type: "text_present" as const, value: "MEMBER_NOT_FOUND" },
      escalate: false,
    },
  ];

  check(
    "a business outcome is not a failure",
    detectCondition(observation({ text: "Result Code: MEMBER_NOT_FOUND" }), declared)?.rule.kind ===
      "business",
  );
  check(
    "a session timeout is hard and escalates",
    (() => {
      const match = detectCondition(observation({ text: "Session expired. Please sign in" }), []);
      return match?.rule.kind === "hard" && match.rule.escalate;
    })(),
  );
  check(
    "an unexpected dialog is recoverable",
    detectCondition(
      observation({
        dialogs: [{ type: "alert", message: "flagged", at: "", handledBy: "auto_dismiss" }],
      }),
      [],
    )?.rule.kind === "recoverable",
  );
  check(
    "a timeout is treated as a transient load",
    detectCondition(observation({}), [], new Error("Timeout 10000ms exceeded"))?.rule.code ===
      "TRANSIENT_LOAD_FAILURE",
  );
  check(
    "a clean page yields no condition",
    detectCondition(observation({ text: "Result Code: OK" }), declared) === undefined,
  );
  check(
    "a declared rule overrides the built-in of the same code",
    detectCondition(observation({ text: "Session expired" }), [
      {
        code: "SESSION_EXPIRED",
        kind: "recoverable" as const,
        description: "tenant auto-renews",
        detect: { type: "text_present" as const, value: "Session expired" },
        recovery: { action: "reload_and_retry" as const, maxAttempts: 1, waitMs: 0 },
        escalate: false,
      },
    ])?.rule.kind === "recoverable",
  );
}

console.log("\nTenant overrides");
{
  const base: CapabilityArtifact = {
    schemaVersion: "2.0.0",
    capability: {
      id: "cap-1",
      name: "member-balance-lookup",
      revision: 1,
      status: "draft",
      description: "lookup",
    },
    target: {
      surface: "web",
      entryUrl: "http://localhost:3000",
      appId: "coreunion-member-servicing",
      appVersion: "4.2",
      tenantId: "base",
      allowedDomains: ["localhost"],
      allowedPathPrefixes: ["/"],
    },
    inputs: {},
    outputs: {},
    successCheckpoint: { type: "text_present", value: "Result Code:", timeoutMs: 10_000 },
    outcomes: [
      {
        code: "SESSION_EXPIRED",
        kind: "hard",
        description: "session ended",
        detect: { type: "text_present", value: "Session expired" },
        escalate: true,
      },
    ],
    steps: [
      {
        id: "step_01",
        action: "click",
        intent: "login",
        risk: "safe",
        optional: false,
        timeoutMs: 10_000,
      },
      {
        id: "step_03",
        action: "click",
        target: {
          description: "Search",
          primary: { strategy: "role", role: "button", value: "Search" },
          fallbacks: [],
        },
        risk: "safe",
        optional: false,
        timeoutMs: 10_000,
      },
    ],
    provenance: {
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "test",
      goal: "lookup",
      model: "none",
      discoveryRunId: "test",
    },
  };

  const override: CapabilityOverride = {
    overrideId: "westside-test",
    description: "test",
    appId: "coreunion-member-servicing",
    appVersion: "4.2",
    tenantId: "westside",
    target: { entryUrl: "http://localhost:3000/?tenant=westside" },
    stepPatches: {
      step_03: {
        target: {
          description: "Find Member",
          primary: { strategy: "role", role: "button", value: "Find Member" },
          fallbacks: [],
        },
      },
    },
    insertSteps: [
      {
        before: "step_01",
        step: {
          id: "westside_acknowledge",
          action: "click",
          risk: "safe",
          optional: false,
          timeoutMs: 10_000,
        },
      },
    ],
    removeSteps: [],
    outcomes: [
      {
        code: "SESSION_EXPIRED",
        kind: "recoverable",
        description: "tenant auto-renews",
        detect: { type: "text_present", value: "Session expired" },
        recovery: { action: "reload_and_retry", maxAttempts: 1, waitMs: 0 },
        escalate: false,
      },
    ],
  };

  const resolved = resolveForTenant(base, override);
  check("sets the tenant id on the resolved artifact", resolved.target.tenantId === "westside");
  check(
    "rewrites the entry URL without forking the flow",
    resolved.target.entryUrl.includes("tenant=westside"),
  );
  check("inserts a tenant-specific step before the first base step", resolved.steps[0].id === "westside_acknowledge");
  check(
    "patches a relabelled control in place",
    resolved.steps.find((step) => step.id === "step_03")?.target?.primary.value === "Find Member",
  );
  check(
    "lets a tenant reclassify a condition without forking",
    resolved.outcomes.find((rule) => rule.code === "SESSION_EXPIRED")?.kind === "recoverable",
  );
  check("records which patches were applied", (resolved.provenance.derivedFrom?.appliedPatches.length ?? 0) > 0);

  let rejectedWrongApp = false;
  try {
    resolveForTenant(base, { ...override, appId: "other-product" });
  } catch (error) {
    rejectedWrongApp = error instanceof OverrideMismatchError;
  }
  check("refuses an override aimed at a different vendor product", rejectedWrongApp);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
