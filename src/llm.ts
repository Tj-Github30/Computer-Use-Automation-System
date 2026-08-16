import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import { AgentDecisionSchema, type AgentDecision, type Observation, type RunInput } from "./types.js";

export type DecisionContext = {
  goal: string;
  observation: Observation;
  history: Array<{ action: string; rationale: string; target?: string }>;
  inputs: RunInput;
  availableInputKeys: string[];
};

export interface DecisionModel {
  name(): string;
  nextDecision(context: DecisionContext): Promise<AgentDecision>;
}

const SYSTEM_PROMPT = `You drive a back-office web application the way a human operator would, one step at a time.

Return exactly one JSON object, no prose and no markdown fences:
{
  "action": "goto" | "click" | "type" | "wait_for_text" | "extract_text" | "finish" | "escalate",
  "rationale": "one short sentence",
  "target": {
    "description": "what a human would call this control",
    "primary": { "strategy": "role|label|placeholder|text|test_id|css|xpath", "value": "...", "role": "button|textbox|link|..." },
    "fallbacks": [ { "strategy": "...", "value": "...", "role": "..." } ],
    "robustness": "why this identification should survive app updates"
  },
  "value": "literal text to type or URL to open",
  "expectedText": "text to wait for",
  "outputKey": "name of the field when action is extract_text",
  "checkpointText": "text that proves the goal was reached, required with finish",
  "escalateReason": "why a human is needed, required with escalate"
}

Rules:
- You are given an accessibility tree. Prefer role/label/placeholder locators, which describe what the operator sees. Use css or xpath only as fallbacks; enterprise apps regenerate markup and ids.
- Always supply at least one fallback locator when you act on a control.
- Emit exactly one action per turn and wait to observe its effect.
- Use extract_text to read each value the goal asks for, before finishing.
- Emit finish only once the goal is visibly satisfied, and include checkpointText.
- Emit escalate if you are blocked, need credentials, or the next step would move money or delete data.
- Never invent record identifiers; use only the provided inputs.
- Never use a value read from a record (a balance, a name, an amount) as a locator value. Locate data cells by their row label or structure, so the step works for any record.`;

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || /quota|rate limit/i.test(message);
}

function suggestedDelayMs(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error);
  const retryAfter = message.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  if (retryAfter) {
    return (Number(retryAfter[1]) + 2) * 1000;
  }
  return Math.min(60_000, 2 ** attempt * 5_000);
}

/**
 * Discovery is a long chain of calls against per-minute quotas, so a single 429
 * should pause the loop rather than abandon a run that is otherwise going well.
 */
async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      const waitMs = suggestedDelayMs(error, attempt);
      process.stderr.write(`rate limited by model API; retrying in ${Math.round(waitMs / 1000)}s\n`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

function parseDecision(raw: string): AgentDecision {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const unfenced = fenced ? fenced[1].trim() : trimmed;
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const payload = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  return AgentDecisionSchema.parse(JSON.parse(payload));
}

function buildUserPayload(context: DecisionContext): string {
  return JSON.stringify({
    goal: context.goal,
    availableInputs: context.availableInputKeys,
    inputs: context.inputs,
    currentState: {
      url: context.observation.url,
      title: context.observation.title,
      accessibilityTree: context.observation.ariaSnapshot,
      visibleText: context.observation.text,
      dialogs: context.observation.dialogs,
    },
    stepsAlreadyTaken: context.history.slice(-12),
  });
}

/**
 * Shared decision loop. A model that returns unparseable JSON gets one corrected
 * retry before the run gives up, because a single malformed response is not a
 * reason to discard an otherwise healthy discovery.
 */
abstract class ApiDecisionModel implements DecisionModel {
  constructor(protected readonly modelName: string) {}

  name(): string {
    return this.modelName;
  }

  protected abstract generate(payload: string, correction?: string): Promise<string>;

  async nextDecision(context: DecisionContext): Promise<AgentDecision> {
    const payload = buildUserPayload(context);
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction =
        attempt === 0
          ? undefined
          : `Your previous reply could not be parsed (${
              lastError instanceof Error ? lastError.message : String(lastError)
            }). Reply with a single strictly valid JSON object and nothing else.`;
      const raw = await withRateLimitRetry(() => this.generate(payload, correction));
      try {
        return parseDecision(raw);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

export class OpenAiDecisionModel extends ApiDecisionModel {
  private readonly client: OpenAI;

  constructor(modelName: string, apiKey: string) {
    super(modelName);
    this.client = new OpenAI({ apiKey });
  }

  protected async generate(payload: string, correction?: string): Promise<string> {
    const response = await this.client.responses.create({
      model: this.modelName,
      temperature: 0,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: correction ? `${payload}\n\n${correction}` : payload },
      ],
    });
    return response.output_text;
  }
}

export class GeminiDecisionModel extends ApiDecisionModel {
  private readonly client: GoogleGenerativeAI;

  constructor(modelName: string, apiKey: string) {
    super(modelName);
    this.client = new GoogleGenerativeAI(apiKey);
  }

  protected async generate(payload: string, correction?: string): Promise<string> {
    const model = this.client.getGenerativeModel({
      model: this.modelName,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    });
    const response = await model.generateContent(
      correction ? `${payload}\n\n${correction}` : payload,
    );
    const raw = response.response.text();
    if (!raw) {
      throw new Error("Gemini returned an empty decision");
    }
    return raw;
  }
}

/**
 * Deterministic stand-in so the repository runs, and the replay path can be
 * exercised, without an API key. It reads the same accessibility tree the real
 * models get and emits the same decision shape.
 */
export class MockDecisionModel implements DecisionModel {
  name(): string {
    return "mock-planner-v2";
  }

  async nextDecision(context: DecisionContext): Promise<AgentDecision> {
    const done = (action: string, marker: string): boolean =>
      context.history.some((step) => step.action === action && (step.target ?? "").includes(marker));
    const tree = context.observation.ariaSnapshot;
    const text = context.observation.text;
    const openingSubAccount = /sub-account|sub account/i.test(context.goal);

    if (!done("click", "Continue") && /Continue/i.test(tree) && /Compliance Notice/i.test(text)) {
      return {
        action: "click",
        rationale: "Dismiss the tenant compliance notice so the workspace is usable.",
        target: {
          description: "Continue button on the compliance notice",
          primary: { strategy: "role", role: "button", value: "Continue" },
          fallbacks: [{ strategy: "text", value: "Continue" }],
          robustness: "Operator-facing label on a tenant interstitial.",
        },
      };
    }

    if (!done("click", "Login") && /Login as Teller/i.test(tree)) {
      return {
        action: "click",
        rationale: "Authenticate into the teller session before searching.",
        target: {
          description: "Login as Teller button",
          primary: { strategy: "role", role: "button", value: "Login as Teller" },
          fallbacks: [{ strategy: "css", value: "#loginBtn" }],
          robustness: "Button text is operator-facing; id is a fallback only.",
        },
      };
    }

    if (!done("type", "Member ID")) {
      return {
        action: "type",
        rationale: "Enter the member identifier supplied by the caller.",
        target: {
          description: "Member ID field",
          primary: { strategy: "label", value: "Member ID" },
          fallbacks: [
            { strategy: "placeholder", value: "e.g. 12345" },
            { strategy: "css", value: "#memberIdInput" },
          ],
          robustness: "Bound to the visible field label rather than markup position.",
        },
        value: String(context.inputs.memberId ?? ""),
      };
    }

    if (!done("click", "Search") && !done("click", "Find Member")) {
      const findMember = /Find Member/i.test(tree);
      return {
        action: "click",
        rationale: "Run the member lookup.",
        target: {
          description: findMember ? "Find Member button" : "Search button",
          primary: {
            strategy: "role",
            role: "button",
            value: findMember ? "Find Member" : "Search",
          },
          fallbacks: [
            { strategy: "text", value: findMember ? "Find Member" : "Search" },
            { strategy: "css", value: "#searchBtn" },
          ],
          robustness: "Role plus accessible name; resilient to layout changes.",
        },
      };
    }

    if (!/Result Code|Confirmation Number|Validation error|Permission denied|Session expired/i.test(text)) {
      return {
        action: "wait_for_text",
        rationale: "Wait for the lookup result to render.",
        expectedText: "Result Code",
      };
    }

    if (openingSubAccount) {
      if (!done("click", "Open New Sub-Account") && /Open New Sub-Account/i.test(tree)) {
        return {
          action: "click",
          rationale: "Open the new sub-account form for this member.",
          target: {
            description: "Open New Sub-Account button",
            primary: { strategy: "role", role: "button", value: "Open New Sub-Account" },
            fallbacks: [{ strategy: "css", value: "#openSubAccountBtn" }],
            robustness: "Role plus the operator-facing label on the member record.",
          },
        };
      }

      if (!done("type", "Product Type")) {
        return {
          action: "type",
          rationale: "Enter the product type supplied by the caller.",
          target: {
            description: "Product Type field",
            primary: { strategy: "label", value: "Product Type" },
            fallbacks: [{ strategy: "css", value: "#productTypeInput" }],
            robustness: "Bound to the visible field label.",
          },
          value: String(context.inputs.productType ?? "Money Market"),
        };
      }

      if (!done("type", "Opening Amount")) {
        return {
          action: "type",
          rationale: "Enter the opening amount supplied by the caller.",
          target: {
            description: "Opening Amount field",
            primary: { strategy: "label", value: "Opening Amount" },
            fallbacks: [{ strategy: "css", value: "#openingAmountInput" }],
            robustness: "Bound to the visible field label.",
          },
          value: String(context.inputs.openingAmount ?? "250.00"),
        };
      }

      if (!done("click", "Submit Application")) {
        return {
          action: "click",
          rationale: "Submit the sub-account application.",
          target: {
            description: "Submit Application button",
            primary: { strategy: "role", role: "button", value: "Submit Application" },
            fallbacks: [{ strategy: "css", value: "#submitSubAccountBtn" }],
            robustness: "Role plus accessible name on the application form.",
          },
        };
      }

      if (!/Confirmation Number/i.test(text)) {
        return {
          action: "wait_for_text",
          rationale: "Wait for the confirmation screen.",
          expectedText: "Confirmation Number",
        };
      }

      if (!done("extract_text", "Confirmation Number")) {
        return {
          action: "extract_text",
          rationale: "Read the confirmation number the caller needs back.",
          target: {
            description: "Confirmation Number value",
            primary: { strategy: "css", value: "#confirmationNumber" },
            fallbacks: [{ strategy: "xpath", value: "//*[@id='confirmationNumber']" }],
            robustness: "Value node has no accessible name; addressed by id with xpath fallback.",
          },
          outputKey: "confirmationNumber",
        };
      }

      return {
        action: "finish",
        rationale: "The confirmation screen shows the new sub-account.",
        checkpointText: "Confirmation Number",
      };
    }

    if (!done("extract_text", "Savings balance") && /Result Code/i.test(text)) {
      return {
        action: "extract_text",
        rationale: "Read the savings balance the goal asked for.",
        target: {
          description: "Savings balance value",
          primary: { strategy: "css", value: "#savingsBalance" },
          fallbacks: [
            { strategy: "xpath", value: "//tr[td[contains(text(), 'Savings Balance')]]/td[2]" },
          ],
          robustness: "Value node has no accessible name; row label is the structural fallback.",
        },
        outputKey: "savingsBalance",
      };
    }

    return {
      action: "finish",
      rationale: "The result panel shows the member's savings balance.",
      checkpointText: "Result Code",
    };
  }
}

export function createDecisionModel(config: AppConfig): DecisionModel {
  if (config.useMockLlm) {
    return new MockDecisionModel();
  }
  if (config.llmProvider === "gemini") {
    if (!config.geminiApiKey) {
      throw new Error("LLM_PROVIDER=gemini but GEMINI_API_KEY is not set");
    }
    return new GeminiDecisionModel(config.geminiModel, config.geminiApiKey);
  }
  if (config.llmProvider === "openai") {
    if (!config.openAiApiKey) {
      throw new Error("LLM_PROVIDER=openai but OPENAI_API_KEY is not set");
    }
    return new OpenAiDecisionModel(config.openAiModel, config.openAiApiKey);
  }
  if (config.geminiApiKey) {
    return new GeminiDecisionModel(config.geminiModel, config.geminiApiKey);
  }
  if (config.openAiApiKey) {
    return new OpenAiDecisionModel(config.openAiModel, config.openAiApiKey);
  }
  throw new Error(
    "No LLM configured. Set USE_MOCK_LLM=true, or provide GEMINI_API_KEY / OPENAI_API_KEY.",
  );
}
