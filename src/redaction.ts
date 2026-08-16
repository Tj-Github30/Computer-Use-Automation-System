const SECRET_KEY_PATTERNS = [
  /pass(word)?/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /authorization/i,
  /credential/i,
  /\bpin\b/i,
  /ssn/i,
  /social.?security/i,
  /card.?number/i,
  /routing.?number/i,
  /cvv/i,
];

const VALUE_PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replace: "[REDACTED_SSN]" },
  { pattern: /\b(?:\d[ -]?){13,19}\b/g, replace: "[REDACTED_CARD]" },
  { pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, replace: "[REDACTED_EMAIL]" },
];

function maskPreservingShape(value: string): string {
  if (value.length <= 4) {
    return "***";
  }
  return `${value.slice(0, 1)}***${value.slice(-1)} (${value.length} chars)`;
}

/**
 * Redaction has two halves: keys we always consider secret, and literal values
 * the run has seen that a capability declared sensitive. The literal half is
 * what keeps extracted balances out of logs, DOM dumps and accessibility
 * snapshots, since those never carry the original field name.
 */
export class Redactor {
  private readonly sensitiveKeys = new Set<string>();
  private readonly literals = new Set<string>();

  declareSensitiveKeys(keys: string[]): void {
    for (const key of keys) {
      this.sensitiveKeys.add(key.toLowerCase());
    }
  }

  declareSensitiveValue(value: unknown): void {
    if (typeof value === "string" && value.trim().length >= 3) {
      this.literals.add(value.trim());
    }
  }

  isSensitiveKey(key: string): boolean {
    return (
      this.sensitiveKeys.has(key.toLowerCase()) ||
      SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key))
    );
  }

  redactText(text: string): string {
    let output = text;
    for (const literal of this.literals) {
      output = output.split(literal).join("[REDACTED]");
    }
    for (const { pattern, replace } of VALUE_PATTERNS) {
      output = output.replace(pattern, replace);
    }
    return output;
  }

  redact<T>(input: T): T {
    return this.walk(input) as T;
  }

  private walk(value: unknown, keyHint?: string): unknown {
    if (typeof value === "string") {
      if (keyHint && this.isSensitiveKey(keyHint)) {
        return maskPreservingShape(value);
      }
      return this.redactText(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item));
    }
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        output[key] = this.walk(nested, key);
      }
      return output;
    }
    return value;
  }
}
