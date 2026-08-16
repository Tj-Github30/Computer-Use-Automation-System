import { appendFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./fs-utils.js";
import type { Redactor } from "./redaction.js";

export type RunEvent = {
  type: string;
  [key: string]: unknown;
};

/**
 * Every persisted event passes through the run's redactor, so evidence is safe
 * by construction rather than by remembering to sanitise at each call site.
 */
export class RunLogger {
  constructor(
    private readonly evidenceDir: string,
    private readonly redactor: Redactor,
  ) {}

  async log(event: RunEvent): Promise<void> {
    await ensureDir(this.evidenceDir);
    const enriched = { at: new Date().toISOString(), ...event };
    const safe = this.redactor.redact(enriched);
    await appendFile(
      path.join(this.evidenceDir, "events.jsonl"),
      `${JSON.stringify(safe)}\n`,
      "utf8",
    );
  }

  dir(): string {
    return this.evidenceDir;
  }
}
