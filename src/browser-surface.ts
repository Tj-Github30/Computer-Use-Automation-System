import path from "node:path";
import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { ensureDir } from "./fs-utils.js";
import { describeCandidate, TargetNotFoundError, type Surface } from "./surface.js";
import type { DialogRecord, ElementTarget, LocatorCandidate, Observation } from "./types.js";

const MIN_CANDIDATE_TIMEOUT_MS = 1500;

export type BrowserSurfaceOptions = {
  headless: boolean;
  /** Applied to every persisted snapshot so evidence never carries raw values. */
  scrubText?: (text: string) => string;
  /**
   * When set, the browser exposes a debugging port so an operator console can
   * attach to the *same* session during a handoff instead of opening a new one.
   */
  takeoverPort?: number;
};

export class BrowserSurface implements Surface {
  private browser?: Browser;
  private page?: Page;
  private dialogs: DialogRecord[] = [];

  constructor(private readonly options: BrowserSurfaceOptions) {}

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Surface not started");
    }
    return this.page;
  }

  async start(): Promise<void> {
    if (this.page) {
      return;
    }
    this.browser = await chromium.launch({
      headless: this.options.headless,
      slowMo: this.options.headless ? 0 : 120,
      args: this.options.takeoverPort
        ? [`--remote-debugging-port=${this.options.takeoverPort}`]
        : [],
    });
    const context = await this.browser.newContext();
    this.page = await context.newPage();

    // Legacy apps throw modal dialogs at operators. Record every one so replay
    // can treat it as a declared condition instead of silently proceeding.
    this.page.on("dialog", (dialog) => {
      this.dialogs.push({
        type: dialog.type(),
        message: dialog.message(),
        at: new Date().toISOString(),
        handledBy: "auto_dismiss",
      });
      void dialog.dismiss().catch(() => undefined);
    });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
  }

  async goto(url: string): Promise<void> {
    await this.requirePage().goto(url, { waitUntil: "load" });
  }

  async reload(): Promise<void> {
    await this.requirePage().reload({ waitUntil: "domcontentloaded" });
  }

  async observe(): Promise<Observation> {
    const page = this.requirePage();
    const body = page.locator("body");
    const [text, ariaSnapshot, title] = await Promise.all([
      body.innerText().catch(() => ""),
      body.ariaSnapshot().catch(() => ""),
      page.title().catch(() => ""),
    ]);
    return {
      url: page.url(),
      title,
      text: text.slice(0, 6000),
      ariaSnapshot: ariaSnapshot.slice(0, 6000),
      dialogs: [...this.dialogs],
    };
  }

  private toLocator(candidate: LocatorCandidate): Locator {
    const page = this.requirePage();
    const exact = candidate.exact ?? false;
    switch (candidate.strategy) {
      case "role":
        return page.getByRole((candidate.role ?? "button") as Parameters<Page["getByRole"]>[0], {
          name: candidate.value,
          exact,
        });
      case "label":
        return page.getByLabel(candidate.value, { exact });
      case "placeholder":
        return page.getByPlaceholder(candidate.value, { exact });
      case "text":
        return page.getByText(candidate.value, { exact });
      case "test_id":
        return page.getByTestId(candidate.value);
      case "xpath":
        return page.locator(`xpath=${candidate.value}`);
      case "css":
      default:
        return page.locator(candidate.value);
    }
  }

  /**
   * Tries the primary locator, then each declared fallback. Returning the
   * candidate that matched lets the caller record which strategy actually held
   * up, which is the raw signal for drift detection across tenants.
   */
  private async resolve(
    target: ElementTarget,
    timeoutMs: number,
  ): Promise<{ locator: Locator; candidate: LocatorCandidate }> {
    const candidates = [target.primary, ...target.fallbacks];
    const perCandidate = Math.max(
      MIN_CANDIDATE_TIMEOUT_MS,
      Math.floor(timeoutMs / Math.max(candidates.length, 1)),
    );
    const attempted: string[] = [];

    for (const candidate of candidates) {
      const locator = this.toLocator(candidate).first();
      try {
        await locator.waitFor({ state: "visible", timeout: perCandidate });
        return { locator, candidate };
      } catch {
        attempted.push(describeCandidate(candidate));
      }
    }
    throw new TargetNotFoundError(target, attempted);
  }

  async click(target: ElementTarget, timeoutMs: number): Promise<LocatorCandidate> {
    const { locator, candidate } = await this.resolve(target, timeoutMs);
    await locator.click({ timeout: timeoutMs });
    return candidate;
  }

  async type(
    target: ElementTarget,
    value: string,
    timeoutMs: number,
  ): Promise<LocatorCandidate> {
    const { locator, candidate } = await this.resolve(target, timeoutMs);
    await locator.fill(value, { timeout: timeoutMs });
    return candidate;
  }

  async waitForText(text: string, timeoutMs: number): Promise<void> {
    await this.requirePage()
      .getByText(text, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });
  }

  async readText(target: ElementTarget, timeoutMs: number): Promise<string> {
    const { locator } = await this.resolve(target, timeoutMs);
    return (await locator.innerText({ timeout: timeoutMs })).trim();
  }

  async isVisible(target: ElementTarget, timeoutMs: number): Promise<boolean> {
    try {
      await this.resolve(target, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async captureScreenshot(evidenceDir: string, name: string): Promise<string> {
    await ensureDir(evidenceDir);
    const filePath = path.join(evidenceDir, `${name}.png`);
    await this.requirePage().screenshot({ path: filePath, fullPage: true });
    return filePath;
  }

  async captureSnapshot(evidenceDir: string, name: string): Promise<string[]> {
    await ensureDir(evidenceDir);
    const page = this.requirePage();
    const scrub = this.options.scrubText ?? ((value: string) => value);

    const ariaPath = path.join(evidenceDir, `${name}.aria.txt`);
    const htmlPath = path.join(evidenceDir, `${name}.html`);
    const aria = await page.locator("body").ariaSnapshot().catch(() => "");
    const html = await page.content().catch(() => "");

    await writeFile(ariaPath, scrub(aria), "utf8");
    await writeFile(htmlPath, scrub(html), "utf8");
    return [ariaPath, htmlPath];
  }

  drainDialogs(): DialogRecord[] {
    const drained = [...this.dialogs];
    this.dialogs = [];
    return drained;
  }

  currentUrl(): string {
    return this.requirePage().url();
  }

  takeoverEndpoint(): string | undefined {
    return this.options.takeoverPort
      ? `http://localhost:${this.options.takeoverPort}`
      : undefined;
  }
}
