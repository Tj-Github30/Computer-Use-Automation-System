import path from "node:path";
import { readdir } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";
import { getConfig } from "./config.js";
import { runDiscovery } from "./discovery.js";
import { readJson, writeJson } from "./fs-utils.js";
import { createDecisionModel } from "./llm.js";
import { resolveForTenant } from "./overrides.js";
import { runReplay } from "./replay.js";
import {
  CapabilityArtifactSchema,
  CapabilityOverrideSchema,
  CapabilitySpecSchema,
  type CapabilityArtifact,
  type RunInput,
} from "./types.js";

const EVIDENCE_ROOT = path.resolve("evidence");
const ARTIFACT_ROOT = path.resolve("artifacts");
const OVERRIDE_ROOT = path.resolve("capabilities/overrides");

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = "true";
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function parseInputs(raw: string | undefined): RunInput {
  if (!raw) {
    return {};
  }
  const inputs: RunInput = {};
  for (const pair of raw.split(",")) {
    const index = pair.indexOf("=");
    if (index > 0) {
      inputs[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }
  }
  return inputs;
}

function flagBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value.toLowerCase() !== "false";
}

async function loadArtifact(artifactPath: string): Promise<CapabilityArtifact> {
  const raw = await readJson<unknown>(path.resolve(artifactPath));
  return CapabilityArtifactSchema.parse(raw);
}

async function listArtifacts(): Promise<string[]> {
  try {
    const entries = await readdir(ARTIFACT_ROOT);
    return entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.join(ARTIFACT_ROOT, entry));
  } catch {
    return [];
  }
}

async function findArtifactByName(name: string): Promise<CapabilityArtifact> {
  const paths = await listArtifacts();
  for (const artifactPath of paths) {
    const artifact = await loadArtifact(artifactPath);
    if (artifact.capability.name === name) {
      return artifact;
    }
  }
  throw new Error(
    `No recorded capability named "${name}". Run \`npm run capabilities\` to list them.`,
  );
}

async function loadOverride(tenantId: string, capabilityName: string) {
  const overridePath = path.join(OVERRIDE_ROOT, `${tenantId}.${capabilityName}.json`);
  try {
    return CapabilityOverrideSchema.parse(await readJson<unknown>(overridePath));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No override for tenant "${tenantId}" on capability "${capabilityName}" at ${overridePath}. ${detail}`,
    );
  }
}

/**
 * The agent-facing resolution path: look up a capability by name (or artifact
 * path), then layer a tenant override if one was requested. Replay never sees
 * the difference — it just gets a fully resolved artifact.
 */
async function resolveInvokedArtifact(flags: Record<string, string>): Promise<CapabilityArtifact> {
  const base = flags.artifact
    ? await loadArtifact(flags.artifact)
    : flags.capability
      ? await findArtifactByName(flags.capability)
      : undefined;
  if (!base) {
    throw new Error("Provide --capability <name> or --artifact <path>.");
  }
  if (!flags.tenant || flags.tenant === base.target.tenantId) {
    return base;
  }
  return resolveForTenant(base, await loadOverride(flags.tenant, base.capability.name));
}

async function commandDiscover(flags: Record<string, string>): Promise<number> {
  const config = getConfig();
  const specPath = flags.spec ?? "capabilities/member-balance-lookup.spec.json";
  const spec = CapabilitySpecSchema.parse(await readJson<unknown>(path.resolve(specPath)));

  const useMockLlm = flags.useMockLlm !== undefined
    ? flagBool(flags.useMockLlm, config.useMockLlm)
    : config.useMockLlm;

  const model = createDecisionModel({ ...config, useMockLlm });

  const result = await runDiscovery({
    goal: flags.goal ?? `Look up a member and read their savings balance`,
    entryUrl: flags.url ?? "http://localhost:3000",
    spec,
    model,
    inputs: parseInputs(flags.inputs ?? "memberId=1001"),
    policy: config.policy,
    maxSteps: Number(flags.maxSteps ?? 15),
    timeoutMs: Number(flags.timeoutMs ?? 120_000),
    headless: flagBool(flags.headless, config.headless),
    evidenceRootDir: EVIDENCE_ROOT,
    artifactRootDir: ARTIFACT_ROOT,
    interactive: flagBool(flags.interactive, Boolean(stdin.isTTY)),
    escalationTimeoutMs: config.escalationTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    takeoverPort: flags.takeoverPort ? Number(flags.takeoverPort) : undefined,
  });

  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "recorded" ? 0 : 1;
}

async function commandReplay(flags: Record<string, string>): Promise<number> {
  if (process.env.USE_MOCK_LLM !== undefined || flags.useMockLlm !== undefined) {
    stdout.write(
      "note: USE_MOCK_LLM is ignored for replay; replay never consults a model.\n",
    );
  }
  const config = getConfig();
  const artifact = await resolveInvokedArtifact(flags);
  const result = await runReplay({
    artifact,
    inputs: parseInputs(flags.inputs),
    policy: config.policy,
    evidenceRootDir: EVIDENCE_ROOT,
    headless: flagBool(flags.headless, config.headless),
    interactive: flagBool(flags.interactive, Boolean(stdin.isTTY)),
    escalationEnabled: flagBool(flags.escalate, true),
    escalationTimeoutMs: Number(flags.escalationTimeoutMs ?? config.escalationTimeoutMs),
    pollIntervalMs: config.pollIntervalMs,
    takeoverPort: flags.takeoverPort ? Number(flags.takeoverPort) : undefined,
  });

  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "failure" ? 1 : 0;
}

/**
 * The agent-facing view: what capabilities exist, what each needs, what it
 * returns. This is the catalogue a calling agent would browse before invoking.
 */
async function commandCapabilities(): Promise<number> {
  const paths = await listArtifacts();
  if (paths.length === 0) {
    stdout.write("No capabilities recorded yet. Run `npm run discover` first.\n");
    return 0;
  }

  const catalogue = [];
  for (const artifactPath of paths) {
    try {
      const artifact = await loadArtifact(artifactPath);
      catalogue.push({
        name: artifact.capability.name,
        revision: artifact.capability.revision,
        status: artifact.capability.status,
        description: artifact.capability.description,
        app: `${artifact.target.appId}@${artifact.target.appVersion}`,
        tenant: artifact.target.tenantId,
        inputs: Object.fromEntries(
          Object.entries(artifact.inputs).map(([key, value]) => [
            key,
            `${value.type}${value.required ? "" : "?"} — ${value.description}`,
          ]),
        ),
        outputs: Object.fromEntries(
          Object.entries(artifact.outputs).map(([key, value]) => [
            key,
            `${value.type}${value.sensitive ? " (sensitive)" : ""} — ${value.description}`,
          ]),
        ),
        businessOutcomes: artifact.outcomes
          .filter((outcome) => outcome.kind === "business")
          .map((outcome) => outcome.code),
        artifactPath,
        invoke: `npm run invoke -- --capability ${artifact.capability.name} --inputs "memberId=<id>"`,
      });
    } catch (error) {
      catalogue.push({
        artifactPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let overrides: Array<Record<string, unknown>> = [];
  try {
    const files = await readdir(OVERRIDE_ROOT);
    for (const file of files.filter((entry) => entry.endsWith(".json"))) {
      const override = CapabilityOverrideSchema.parse(
        await readJson<unknown>(path.join(OVERRIDE_ROOT, file)),
      );
      overrides.push({
        overrideId: override.overrideId,
        tenant: override.tenantId,
        app: `${override.appId}@${override.appVersion ?? "*"}`,
        description: override.description,
        invoke: `npm run invoke -- --capability ${file.split(".").slice(1, -1).join(".")} --tenant ${override.tenantId} --inputs "memberId=<id>"`,
      });
    }
  } catch {
    overrides = [];
  }

  stdout.write(`${JSON.stringify({ capabilities: catalogue, tenantOverrides: overrides }, null, 2)}\n`);
  return 0;
}

/**
 * Agent-facing invocation. A calling agent discovers a capability by name
 * (`npm run capabilities`) and invokes it with typed args — no artifact path,
 * no model, no knowledge of how the UI is driven.
 */
async function commandInvoke(flags: Record<string, string>): Promise<number> {
  if (!flags.capability && !flags.artifact) {
    throw new Error("invoke requires --capability <name> (or --artifact <path>).");
  }
  return commandReplay(flags);
}

/**
 * Mock operator console. Real mechanism, minimal surface: it lists pending
 * intervention requests and writes the resolution the waiting run polls for.
 */
async function commandOperator(flags: Record<string, string>): Promise<number> {
  const pending: Array<Record<string, unknown>> = [];
  let runDirs: string[] = [];
  try {
    runDirs = await readdir(EVIDENCE_ROOT);
  } catch {
    stdout.write("No evidence directory yet.\n");
    return 0;
  }

  for (const runDir of runDirs) {
    const interventionsRoot = path.join(EVIDENCE_ROOT, runDir, "interventions");
    let interventionIds: string[] = [];
    try {
      interventionIds = await readdir(interventionsRoot);
    } catch {
      continue;
    }
    for (const interventionId of interventionIds) {
      const dir = path.join(interventionsRoot, interventionId);
      try {
        await readJson(path.join(dir, "resolution.json"));
        continue; // already resolved
      } catch {
        // still open
      }
      try {
        const request = await readJson<Record<string, unknown>>(path.join(dir, "request.json"));
        pending.push({ dir, ...request });
      } catch {
        continue;
      }
    }
  }

  if (flags.resolve) {
    const dir = path.resolve(flags.resolve);
    const request = await readJson<{ takeoverEndpoint?: string }>(
      path.join(dir, "request.json"),
    );

    const performed: string[] = [];
    // `--click` lets the operator act on the *same* live session the automation
    // paused, attaching over the takeover endpoint rather than opening a new one.
    if (flags.click && request.takeoverEndpoint) {
      const browser = await chromium.connectOverCDP(request.takeoverEndpoint);
      try {
        const page = browser.contexts()[0]?.pages()[0];
        if (!page) {
          throw new Error("No live page found at the takeover endpoint");
        }
        for (const name of flags.click.split("|")) {
          await page.getByRole("button", { name: name.trim() }).first().click({ timeout: 10_000 });
          performed.push(`clicked "${name.trim()}"`);
        }
      } finally {
        // Do not browser.close() — this CDP connection is the live automation
        // session. Closing it would kill the handoff target.
      }
    }

    const resolution = {
      interventionId: path.basename(dir),
      operator: flags.operator ?? "operator-console",
      notes:
        flags.notes ??
        (performed.length > 0
          ? performed.join("; ")
          : "Manual steps completed on the live session."),
      manualActions: performed,
      action: flags.abort === "true" ? "abort" : "resume",
      resolvedAt: new Date().toISOString(),
    };
    await writeJson(path.join(dir, "resolution.json"), resolution);
    stdout.write(`${JSON.stringify(resolution, null, 2)}\n`);
    return 0;
  }

  stdout.write(`${JSON.stringify({ pendingInterventions: pending }, null, 2)}\n`);
  return 0;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));

  const exitCode = await (async () => {
    switch (command) {
      case "discover":
        return commandDiscover(flags);
      case "replay":
        return commandReplay(flags);
      case "capabilities":
        return commandCapabilities();
      case "invoke":
        return commandInvoke(flags);
      case "operator":
        return commandOperator(flags);
      default:
        throw new Error(
          "Unknown command. Use: discover | replay | invoke | capabilities | operator",
        );
    }
  })();

  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
