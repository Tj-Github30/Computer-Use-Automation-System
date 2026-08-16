import type { DialogRecord, ElementTarget, LocatorCandidate, Observation } from "./types.js";

/**
 * The seam between "how we perceive and act on a surface" and "the recorded
 * flow". Steps in an artifact are expressed only in terms of these operations,
 * so a legacy-web or desktop adapter can implement the same interface without
 * touching the replay engine or the schema.
 */
export interface Surface {
  start(): Promise<void>;
  close(): Promise<void>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  observe(): Promise<Observation>;
  click(target: ElementTarget, timeoutMs: number): Promise<LocatorCandidate>;
  type(target: ElementTarget, value: string, timeoutMs: number): Promise<LocatorCandidate>;
  waitForText(text: string, timeoutMs: number): Promise<void>;
  readText(target: ElementTarget, timeoutMs: number): Promise<string>;
  isVisible(target: ElementTarget, timeoutMs: number): Promise<boolean>;
  captureScreenshot(evidenceDir: string, name: string): Promise<string>;
  captureSnapshot(evidenceDir: string, name: string): Promise<string[]>;
  drainDialogs(): DialogRecord[];
  currentUrl(): string;
  /**
   * Address at which an operator console can attach to this same live session.
   * Undefined when the surface was started without a takeover channel.
   */
  takeoverEndpoint(): string | undefined;
}

export class TargetNotFoundError extends Error {
  constructor(
    readonly target: ElementTarget,
    readonly attempted: string[],
  ) {
    super(
      `Could not locate "${target.description}". Tried: ${attempted.join(", ") || "no candidates"}`,
    );
    this.name = "TargetNotFoundError";
  }
}

export function describeCandidate(candidate: LocatorCandidate): string {
  return candidate.role
    ? `${candidate.strategy}[${candidate.role}]=${candidate.value}`
    : `${candidate.strategy}=${candidate.value}`;
}
