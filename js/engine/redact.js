// Redaction runs at ingestion, BEFORE anything is stored or analysed.
// The original secret is never kept: only the masked text and a finding record.

const SECRET_PATTERNS = [
  { name: "SendGrid API key", re: /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "OpenAI-style secret key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Razorpay key", re: /\brzp_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: "Stripe key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "Password or secret assignment", re: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/gi },
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){9,13}\d\b/g;

/**
 * @returns {{text: string, findings: Array<{kind: string, name: string}>}}
 */
export function redact(text) {
  if (!text) return { text: text || "", findings: [] };
  const findings = [];
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, () => {
      findings.push({ kind: "secret", name: p.name });
      return "[secret removed]";
    });
  }
  out = out.replace(EMAIL, () => {
    findings.push({ kind: "personal", name: "Email address" });
    return "[email masked]";
  });
  out = out.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 10) return m; // dates and short numbers are not phone numbers
    findings.push({ kind: "personal", name: "Phone number" });
    return "[phone masked]";
  });
  return { text: out, findings };
}
