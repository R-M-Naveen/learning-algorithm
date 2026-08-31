// Redaction: the one gate between raw engine/app text and anything persisted.
// The pipeline is raw -> redactText -> LearningEvent -> store; the store
// additionally refuses free text that still trips looksSecret, so a missed
// call site fails loudly instead of leaking quietly.

const REPLACEMENT = "[REDACTED]";

// Well-known credential shapes. Deliberately prefix-anchored: high-precision
// beats high-recall here, because the assignment/field rules below catch the
// general "something named like a secret" case.
const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abps]-[A-Za-z0-9-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
];

// NAME=value / NAME: value where NAME smells like a credential. The name
// survives (it is the useful part of a summary); only the value goes.
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)(\s*[:=]\s*)("?)([^\s"',;]{6,})\3/g;
const SECRETY_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)/i;

// "apiKey": "value" JSON fields, same rule: field name stays, value goes.
const JSON_FIELD =
  /("(?:[A-Za-z0-9_.-]*?(?:key|token|secret|password|credentials?)[A-Za-z0-9_.-]*)"\s*:\s*)"([^"]{4,})"/gi;

export function redactText(text: string): string {
  let out = text;
  out = out.replace(JSON_FIELD, (_m, head: string) => `${head}"${REPLACEMENT}"`);
  out = out.replace(ASSIGNMENT, (m, name: string, sep: string, q: string) =>
    SECRETY_NAME.test(name) ? `${name}${sep}${q}${REPLACEMENT}${q}` : m,
  );
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REPLACEMENT);
  return out;
}

/** True when text still contains something the redactor would change —
 *  the store's belt-and-suspenders refusal check. */
export function looksSecret(text: string): boolean {
  return redactText(text) !== text;
}
