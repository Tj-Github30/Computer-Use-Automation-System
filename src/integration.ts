/**
 * Deterministic replay cases plus a navigation-allowlist proof.
 * Run with `npm run integration` (also part of `npm test`).
 */
import { createServer } from "node:net";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { BrowserSurface } from "./browser-surface.js";
import { listenDemoApp } from "./demo-app/server.js";
import { readJson, writeJson } from "./fs-utils.js";
import { resolveForTenant } from "./overrides.js";
import { defaultPolicy, PolicyViolationError } from "./policy.js";
import { runReplay } from "./replay.js";
import {
  CapabilityArtifactSchema,
  CapabilityOverrideSchema,
  type CapabilityArtifact,
  type ReplayResult,
} from "./types.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not bind"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function withBaseUrl(artifact: CapabilityArtifact, baseUrl: string): CapabilityArtifact {
  return {
    ...artifact,
    target: { ...artifact.target, entryUrl: `${baseUrl}/` },
  };
}

async function waitForInterventionDir(root: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let runs: string[] = [];
    try {
      runs = await readdir(root);
    } catch {
      runs = [];
    }
    for (const run of runs) {
      const interventions = path.join(root, run, "interventions");
      let ids: string[] = [];
      try {
        ids = await readdir(interventions);
      } catch {
        continue;
      }
      for (const id of ids) {
        const dir = path.join(interventions, id);
        try {
          await readJson(path.join(dir, "request.json"));
          try {
            await readJson(path.join(dir, "resolution.json"));
          } catch {
            return dir;
          }
        } catch {
          continue;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("timed out waiting for an intervention request");
}

async function main(): Promise<void> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = await listenDemoApp(port);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cua-int-"));
  const policy = {
    ...defaultPolicy,
    allowedDomains: ["localhost", "127.0.0.1"],
  };

  const lookup = CapabilityArtifactSchema.parse(
    await readJson(path.resolve("artifacts/member-balance-lookup.v1.json")),
  );
  const override = CapabilityOverrideSchema.parse(
    await readJson(path.resolve("capabilities/overrides/westside.member-balance-lookup.json")),
  );
  override.target.entryUrl = `${baseUrl}/?tenant=westside`;

  const replay = async (label: string, inputs: Record<string, string>, extra?: Partial<Parameters<typeof runReplay>[0]>) => {
    const result = await runReplay({
      artifact: withBaseUrl(lookup, baseUrl),
      inputs,
      policy,
      evidenceRootDir: tmp,
      headless: true,
      interactive: false,
      escalationEnabled: false,
      escalationTimeoutMs: 5_000,
      pollIntervalMs: 200,
      ...extra,
    });
    return result;
  };

  console.log("\nReplay integration");
  {
    const happy = await replay("happy", { memberId: "12345" });
    check("happy path succeeds", happy.status === "success", happy.status);
    check(
      "happy path returns the member savings",
      String(happy.outputs.savingsBalance ?? "").includes("18,640.55"),
      String(happy.outputs.savingsBalance),
    );

    const missing = await replay("not-found", { memberId: "9999" });
    check(
      "business outcome MEMBER_NOT_FOUND",
      missing.status === "business_outcome" && missing.businessOutcome?.code === "MEMBER_NOT_FOUND",
      missing.status,
    );

    const dialog = await replay("dialog", { memberId: "7007" });
    check("recoverable dialog still succeeds", dialog.status === "success", dialog.status);
    check(
      "recoverable dialog is reported",
      dialog.recoveries.some((item) => item.code === "UNEXPECTED_DIALOG"),
      JSON.stringify(dialog.recoveries),
    );

    const denied = await replay("denied", { memberId: "4004" });
    check(
      "hard outcome PERMISSION_DENIED",
      denied.status === "failure" && denied.failure?.conditionCode === "PERMISSION_DENIED",
      `${denied.status} ${denied.failure?.conditionCode ?? denied.failure?.classification}`,
    );

    const westside = await runReplay({
      artifact: resolveForTenant(withBaseUrl(lookup, baseUrl), override),
      inputs: { memberId: "12345" },
      policy,
      evidenceRootDir: tmp,
      headless: true,
      interactive: false,
      escalationEnabled: false,
      escalationTimeoutMs: 5_000,
      pollIntervalMs: 200,
    });
    check(
      "tenant override reuses the base recording",
      westside.status === "success" && String(westside.outputs.savingsBalance ?? "").includes("18,640.55"),
      westside.status,
    );
  }

  console.log("\nNavigation allowlist");
  {
    const surface = new BrowserSurface({ headless: true, policy });
    await surface.start();
    try {
      await surface.goto(`${baseUrl}/`);
      let thrown: unknown;
      try {
        await surface.click(
          {
            description: "Open Core Processor Portal",
            primary: { strategy: "role", role: "button", value: "Open Core Processor Portal" },
            fallbacks: [{ strategy: "text", value: "Open Core Processor Portal" }],
          },
          8_000,
        );
      } catch (error) {
        thrown = error;
      }
      check(
        "click that redirects off-allowlist throws PolicyViolationError",
        thrown instanceof PolicyViolationError,
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      check(
        "session remains on an allowed URL",
        surface.currentUrl().startsWith(baseUrl),
        surface.currentUrl(),
      );
    } finally {
      await surface.close();
    }
  }

  console.log("\nLive-session handoff");
  {
    const takeoverPort = await freePort();
    const evidenceRoot = process.env.CAPTURE_HANDOFF === "1" ? path.resolve("evidence") : tmp;
    const replayPromise = runReplay({
      artifact: withBaseUrl(lookup, baseUrl),
      inputs: { memberId: "5005" },
      policy,
      evidenceRootDir: evidenceRoot,
      headless: true,
      interactive: false,
      escalationEnabled: true,
      escalationTimeoutMs: 45_000,
      pollIntervalMs: 250,
      takeoverPort,
    });

    try {
      const dir = await waitForInterventionDir(evidenceRoot, 20_000);
      const endpoint = `http://127.0.0.1:${takeoverPort}`;
      let attached = false;
      for (let attempt = 0; attempt < 15 && !attached; attempt += 1) {
        try {
          const browser = await chromium.connectOverCDP(endpoint);
          try {
            const page = browser.contexts()[0]?.pages()[0];
            if (!page) {
              throw new Error("no page");
            }
            await page.getByRole("button", { name: "Login as Teller" }).first().click({ timeout: 10_000 });
            attached = true;
          } finally {
            // Leave the automation Chromium running.
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      check("operator attached to the live session", attached);

      await writeJson(path.join(dir, "resolution.json"), {
        interventionId: path.basename(dir),
        operator: "teller04",
        notes: "Signed back in as teller after session expiry.",
        manualActions: ['clicked "Login as Teller"'],
        action: "resume",
        resolvedAt: new Date().toISOString(),
      });

      const result: ReplayResult = await replayPromise;
      check(
        "handoff resumes and completes lookup 5005",
        result.status === "success" && String(result.outputs.savingsBalance ?? "").includes("2,145.60"),
        `${result.status} ${JSON.stringify(result.outputs)}`,
      );

      if (process.env.CAPTURE_HANDOFF === "1") {
        const runDir = path.dirname(path.dirname(dir));
        const curated = path.join(evidenceRoot, "handoff-session-expired-5005");
        await rm(curated, { recursive: true, force: true });
        await cp(runDir, curated, { recursive: true });
        if (path.basename(runDir) !== "handoff-session-expired-5005") {
          await rm(runDir, { recursive: true, force: true });
        }
        check("handoff evidence copied to evidence/handoff-session-expired-5005", true);
      }
    } catch (error) {
      check("handoff flow", false, error instanceof Error ? error.message : String(error));
      await replayPromise.catch(() => undefined);
    }
  }

  await rm(tmp, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  if (failures > 0) {
    console.log(`\n${failures} integration check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll integration checks passed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
