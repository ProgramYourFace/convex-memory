// Keys pasted into a conversation never reach memory: they are replaced before a message is stored in the record, and a
// memory, correction or merge holding one (or a password stated with its value) is never kept.

const PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bwhsec_[A-Za-z0-9+/=]{16,}/g, // Stripe webhook secrets
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  // OpenAI: a legacy key is sk- and 32+ letters and digits (no hyphens, a digit among them); a project, service account,
  // admin or unscoped key is sk-proj- / sk-svcacct- / sk-admin- / sk-None- and 40+ base64url characters with a digit and
  // a capital among them. Words joined by hyphens ("sk-learn-and-pandas-…") are neither.
  /\bsk-(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,}\b/g,
  /\bsk-(?:proj|svcacct|admin|None)-(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{40,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access tokens
  /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g, // Resend
  /\b(?:ntn|secret)_[A-Za-z0-9]{40,}\b/g, // Notion
  /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}\b/g, // Linear
  /\bSK[0-9a-fA-F]{32}\b/g, // Twilio API keys
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[key removed]';

/** The text with key-shaped strings replaced, and whether any were. */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return { text: out, redacted: out !== text };
}

/**
 * A password, passcode, passphrase or PIN stated with its value ("the wifi password is Orchard2026!", "PIN: 4821",
 * "the passcode was changed to 9911"). The value counts when it is quoted, follows `:` or `=`, or holds a digit or a
 * symbol, so talk about passwords ("the password is required", "our password manager is 1Password") is not one.
 */
const PASSWORD =
  /\b(?:pass(?:word|code|phrase)s?|passwd|pwd|pins?)\b(?:\s+for\s+[^\n.,;:=]{1,40}?)?\s*(?:(?:is|was|are)(?:\s+now|\s+set\s+to|\s+changed\s+to)?|(?:set|changed)\s+to|[:=])\s*(["'`“‘][^"'`”’\n]{3,}["'`”’]|\S{3,})/gi;

function statesPassword(text: string): boolean {
  for (const m of text.matchAll(PASSWORD)) {
    const value = m[1]!.replace(/[.,;!?)]+$/, '');
    const quoted = /^["'`“‘]/.test(value);
    const assigned = /[:=]\s*\S+$/.test(m[0]) && !/\b(?:is|was|are|to)\s*\S+$/i.test(m[0]);
    if (quoted || (assigned && value.length >= 4) || (value.length >= 4 && /[\d\W_]/.test(value))) return true;
  }
  return false;
}

/**
 * Whether `text` holds a secret memory never keeps: a key- or token-shaped string, or a password, passcode
 * or PIN stated with its value. Passwords look like anything, so one stated otherwise is kept out by the memory prompts.
 */
export const holdsSecret = (text: string): boolean => redactSecrets(text).redacted || statesPassword(text);

/** Why a memory holding a key, token or password was not kept. */
export const SECRET_IN_MEMORY =
  'That looks like a key, token or password, and memory never keeps one: everyone and every agent the memory reaches could read it. Nothing was kept. Keep secrets in a secrets manager, where apps and agents can use them without seeing them.';
