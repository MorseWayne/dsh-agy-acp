// Diagnostic text sanitization shared across ACP, runtime, and status snapshots.
// Always redacts credentials across the FULL raw string before slicing the tail.

const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

const AUTH_HEADER_RE = /((?:proxy-)?authorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi
const COOKIE_HEADER_RE = /((?:set-)?cookie\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi
const BEARER_BASIC_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi
const URL_QUERY_SECRET_RE =
  /([?&](?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|secret|password|auth)=)[^&\s#'"]+/gi
const KV_SECRET_RE =
  /(^|[\s,{(\[;])(["']?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|credential|(?:set[_-]?)?cookie|(?:proxy[_-]?)?authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;\])}`"']+)/gi

const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}/g
const GOOGLE_OAUTH_RE = /\bya29\.[0-9A-Za-z._-]+/g
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}/g
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g

/**
 * Strip ANSI/control characters, redact credentials/tokens/proxy auth across the full text,
 * collapse whitespace, and retain at most the trailing `maxChars` characters.
 */
export function sanitizeDiagnosticText(raw: string, maxChars = 400): string {
  if (!raw) return ''
  let text = raw
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(CONTROL_CHARS_RE, '')

  text = text
    .replace(AUTH_HEADER_RE, '$1[REDACTED]')
    .replace(COOKIE_HEADER_RE, '$1[REDACTED]')
    .replace(BEARER_BASIC_RE, '$1 [REDACTED]')
    .replace(URL_USERINFO_RE, '$1***@')
    .replace(URL_QUERY_SECRET_RE, '$1[REDACTED]')
    .replace(KV_SECRET_RE, '$1$2[REDACTED]')
    .replace(GOOGLE_API_KEY_RE, '[REDACTED]')
    .replace(GOOGLE_OAUTH_RE, '[REDACTED]')
    .replace(SK_KEY_RE, '[REDACTED]')
    .replace(JWT_RE, '[REDACTED]')

  text = text
    .replace(/[\r\n]+/g, ' | ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(?:\s*\|\s*){2,}/g, ' | ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .trim()

  if (maxChars > 0 && text.length > maxChars) {
    return '...' + text.slice(text.length - Math.max(0, maxChars - 3))
  }
  return text
}
