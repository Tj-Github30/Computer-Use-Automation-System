import type { RunLogger } from "./logger.js";
import type { ControlOwner } from "./types.js";

/**
 * Single source of truth for who may act on the live session. Both the
 * automation and the operator console read it, so "who is in control" is an
 * explicit state rather than an implicit consequence of who happens to be
 * typing.
 */
export class SessionControl {
  private owner: ControlOwner = "automation";

  constructor(
    private readonly logger: RunLogger,
    private readonly sessionId: string,
  ) {}

  current(): ControlOwner {
    return this.owner;
  }

  id(): string {
    return this.sessionId;
  }

  assertAutomationMayAct(): void {
    if (this.owner !== "automation") {
      throw new Error(
        `Automation attempted to act while control is held by ${this.owner}. ` +
          "Control must be handed back before the run resumes.",
      );
    }
  }

  async transferTo(owner: ControlOwner, reason: string): Promise<void> {
    const previous = this.owner;
    this.owner = owner;
    await this.logger.log({
      type: "control_transfer",
      sessionId: this.sessionId,
      from: previous,
      to: owner,
      reason,
    });
  }
}
