/**
 * Best-effort PII / secret redaction for accepted events (issue #54).
 *
 * The event schema (docs/event-schema.md) lets `tool_call_start.input`
 * and `tool_call_end.result` carry arbitrary JSON, and `message` carry
 * arbitrary free text. In real fleets those routinely contain customer
 * PII, API responses with tokens, or DB rows with private fields. This
 * module strips likely-sensitive data out of exactly those three fields
 * before the `POST /events` handler applies, broadcasts, logs, or
 * persists the event — one central pass, so every downstream consumer
 * (live WS viewers, the JSONL log, the SQLite store) sees the same
 * scrubbed payload.
 *
 * Two mechanisms, applied together:
 *
 *  - **Field-name denylist** (case-insensitive): any object key whose
 *    name is on the list has its *entire* value replaced with the
 *    marker, whatever its shape (string, number, nested object). Catches
 *    `{ "password": "..." }`, `{ "apiKey": {...} }`, etc. regardless of
 *    whether the value looks secret.
 *  - **Value patterns**: every string leaf is run through a list of
 *    regexes for common secret/token/PII shapes (OpenAI `sk-` keys,
 *    `Bearer` headers, AWS/GitHub/Slack/Google keys, JWTs, PEM private
 *    keys, emails, card-like number groups) and each match is swapped
 *    for the marker.
 *
 * Both recurse through nested objects and arrays. Non-string, non-object
 * leaves (numbers, booleans, null) are left untouched unless their key
 * is on the denylist.
 *
 * IMPORTANT: this is best-effort pattern matching, NOT a compliance
 * guarantee. Novel key shapes, secrets split across fields, or
 * sensitive data that simply looks like ordinary prose will pass
 * through. Agents feeding genuinely sensitive data into tool calls
 * remain responsible for not doing so, or for pre-redacting it
 * themselves. See docs/event-schema.md ("Redaction") and SECURITY.md.
 *
 * Config (resolved once at startup by `loadRedactionConfig`, so the
 * regexes compile a single time and the `/events` hot path just walks
 * the payload):
 *
 *  - `AGENTSVIZ_REDACTION`     — `off`/`0`/`false`/`no` disables the pass
 *                                entirely (default: on).
 *  - `AGENTSVIZ_REDACT_FIELDS` — extra comma-separated field names to add
 *                                to the denylist.
 *  - `AGENTSVIZ_REDACT_PATTERNS` — extra comma-separated regex sources to
 *                                add to the value-pattern list; each is
 *                                compiled with the `g` (and `i`) flags.
 *                                An un-compilable entry is warned about
 *                                and skipped.
 */

export const REDACTED_MARKER = "[REDACTED]";

/** Event fields the redaction pass is allowed to touch. */
const REDACTABLE_FIELDS = ["input", "result", "message"] as const;

/**
 * Object keys whose value is always redacted wholesale, matched
 * case-insensitively. Kept deliberately broad — a false positive just
 * masks a field in the dashboard, a false negative leaks a secret.
 */
export const DEFAULT_REDACT_FIELDS: string[] = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "client_secret",
  "clientsecret",
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "session_token",
  "sessiontoken",
  "api_key",
  "apikey",
  "api_secret",
  "apisecret",
  "authorization",
  "auth_token",
  "authtoken",
  "private_key",
  "privatekey",
  "secret_key",
  "secretkey",
  "credentials",
  "ssn",
  "social_security_number",
  "credit_card",
  "creditcard",
  "card_number",
  "cardnumber",
  "cvv",
  "cvc",
  "pin",
];

/**
 * Value-shape patterns. Every entry MUST be global (`g`) so
 * `String.prototype.replace` swaps every occurrence, not just the first.
 * Ordered roughly specific -> generic.
 */
export const DEFAULT_REDACT_PATTERNS: RegExp[] = [
  // PEM private key blocks (multi-line).
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  // JSON Web Tokens: header.payload.signature, all base64url.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // OpenAI-style keys: sk-... / sk-proj-... (also covers Anthropic sk-ant-).
  /\bsk-(?:[A-Za-z0-9_-]+-)?[A-Za-z0-9]{16,}\b/g,
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ + 36+ chars.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  // Slack tokens: xoxb-, xoxp-, xoxa-, xoxr-, xoxs-.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  // `Bearer <token>` / `Basic <token>` in an Authorization-header-ish string.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Email addresses.
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // Credit-card-like: 4 groups of 4 digits (optional space/dash separators),
  // last group 1-4 digits to also catch 13-15 digit variants.
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g,
];

export interface RedactionConfig {
  /** When false, `redactEvent` returns its input untouched. */
  enabled: boolean;
  /** Lower-cased field-name denylist. */
  fieldNames: Set<string>;
  /** Compiled value-shape patterns (all global). */
  patterns: RegExp[];
  /** Replacement marker. */
  marker: string;
}

/** Parse a boolean-ish env var; anything falsy-looking disables. */
function envDisables(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["0", "false", "off", "no", "disabled"].includes(raw.trim().toLowerCase());
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the redaction config from the environment. Call once at
 * startup: compiling the regexes and building the Set here keeps the
 * per-request path allocation-free.
 */
export function loadRedactionConfig(env: NodeJS.ProcessEnv = process.env): RedactionConfig {
  const enabled = !envDisables(env.AGENTSVIZ_REDACTION);

  const fieldNames = new Set(DEFAULT_REDACT_FIELDS.map((f) => f.toLowerCase()));
  for (const extra of parseList(env.AGENTSVIZ_REDACT_FIELDS)) {
    fieldNames.add(extra.toLowerCase());
  }

  const patterns = [...DEFAULT_REDACT_PATTERNS];
  for (const src of parseList(env.AGENTSVIZ_REDACT_PATTERNS)) {
    try {
      // Force `g` so replace() is global; add `i` for convenience.
      patterns.push(new RegExp(src, "gi"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[redact] ignoring un-compilable AGENTSVIZ_REDACT_PATTERNS entry ${JSON.stringify(src)}: ${reason}`);
    }
  }

  return { enabled, fieldNames, patterns, marker: REDACTED_MARKER };
}

/** Apply every value pattern to a string, replacing matches with the marker. */
function scrubString(value: string, config: RedactionConfig): string {
  let out = value;
  for (const pattern of config.patterns) {
    // Patterns are declared global; reset lastIndex defensively in case a
    // caller passed a stateful regex in via config.
    pattern.lastIndex = 0;
    out = out.replace(pattern, config.marker);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively redact a JSON-ish value. Returns a redacted *copy* —
 * objects and arrays are rebuilt, primitives returned as-is — so the
 * caller's original object is never mutated.
 */
function redactValue(value: unknown, config: RedactionConfig): unknown {
  if (typeof value === "string") {
    return scrubString(value, config);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, config));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (config.fieldNames.has(key.toLowerCase())) {
        // Denylisted key: mask the whole value regardless of its shape.
        out[key] = config.marker;
      } else {
        out[key] = redactValue(child, config);
      }
    }
    return out;
  }
  // number / boolean / null / undefined — nothing to scrub.
  return value;
}

/**
 * Return a copy of `event` with `input`, `result`, and `message`
 * recursively redacted per `config`. Pure: never mutates `event`. When
 * `config.enabled` is false, or none of the redactable fields are
 * present, the original reference is returned unchanged.
 */
export function redactEvent<T>(event: T, config: RedactionConfig): T {
  if (!config.enabled || !isPlainObject(event)) return event;

  let copy: Record<string, unknown> | undefined;
  for (const field of REDACTABLE_FIELDS) {
    if (!(field in event)) continue;
    const redacted = redactValue(event[field], config);
    if (redacted !== event[field]) {
      copy ??= { ...event };
      copy[field] = redacted;
    }
  }

  return (copy ?? event) as T;
}
