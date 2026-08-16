import dotenv from "dotenv";
import { defaultPolicy, type IrreversibleActionPolicy, type PolicyConfig } from "./policy.js";

dotenv.config({ quiet: true });

export type LlmProvider = "gemini" | "openai" | "auto";

export type AppConfig = {
  llmProvider: LlmProvider;
  geminiApiKey?: string;
  geminiModel: string;
  openAiApiKey?: string;
  openAiModel: string;
  /** Discovery only. Replay never consults a model. */
  useMockLlm: boolean;
  headless: boolean;
  policy: PolicyConfig;
  escalationTimeoutMs: number;
  pollIntervalMs: number;
};

function parseProvider(raw: string | undefined): LlmProvider {
  const value = (raw ?? "auto").toLowerCase();
  if (value === "gemini" || value === "openai" || value === "auto") {
    return value;
  }
  throw new Error(`Invalid LLM_PROVIDER "${raw}". Use gemini, openai, or auto.`);
}

function parseIrreversiblePolicy(raw: string | undefined): IrreversibleActionPolicy {
  const value = (raw ?? "confirm").toLowerCase();
  if (value === "confirm" || value === "block" || value === "allow") {
    return value;
  }
  throw new Error(`Invalid IRREVERSIBLE_ACTION_POLICY "${raw}". Use confirm, block, or allow.`);
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getConfig(): AppConfig {
  const policy: PolicyConfig = {
    ...defaultPolicy,
    allowedDomains: parseList(process.env.ALLOWED_DOMAINS, defaultPolicy.allowedDomains),
    allowedPathPrefixes: parseList(
      process.env.ALLOWED_PATH_PREFIXES,
      defaultPolicy.allowedPathPrefixes,
    ),
    irreversibleActionPolicy: parseIrreversiblePolicy(process.env.IRREVERSIBLE_ACTION_POLICY),
  };

  return {
    llmProvider: parseProvider(process.env.LLM_PROVIDER),
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    useMockLlm: (process.env.USE_MOCK_LLM ?? "true").toLowerCase() === "true",
    headless: (process.env.HEADLESS ?? "false").toLowerCase() === "true",
    policy,
    escalationTimeoutMs: Number(process.env.ESCALATION_TIMEOUT_MS ?? 120_000),
    pollIntervalMs: Number(process.env.ESCALATION_POLL_MS ?? 1_000),
  };
}
