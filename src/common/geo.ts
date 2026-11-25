import type { GeoFenceMode } from './types.ts'

export const GEO_FENCE_MODES = ['block', 'strict', 'warn', 'off'] as const

/**
 * Regions known to be restricted by Google Generative AI / Antigravity geo-fencing.
 */
export const GEO_BLOCKED_COUNTRIES: ReadonlySet<string> = new Set([
  'CN', // Mainland China
  'HK', // Hong Kong
  'MO', // Macao
  'RU', // Russia
  'BY', // Belarus
  'IR', // Iran
  'KP', // North Korea
  'SY', // Syria
  'CU', // Cuba
])

/**
 * Non-country placeholder codes returned by CDNs/GeoIP providers (e.g. Cloudflare XX = unknown, T1 = Tor).
 */
export const GEO_PLACEHOLDER_COUNTRIES: ReadonlySet<string> = new Set(['XX', 'T1', 'ZZ', 'AA'])

export function isGeoFenceMode(value: unknown): value is GeoFenceMode {
  return typeof value === 'string' && (GEO_FENCE_MODES as readonly string[]).includes(value)
}

export function normalizeGeoCountryCode(
  code: string | null | undefined,
): { kind: 'valid'; country: string } | { kind: 'placeholder'; raw: string } | { kind: 'invalid' } {
  if (typeof code !== 'string') return { kind: 'invalid' }
  const upper = code.trim().toUpperCase()
  if (GEO_PLACEHOLDER_COUNTRIES.has(upper)) return { kind: 'placeholder', raw: upper }
  if (!/^[A-Z]{2}$/.test(upper)) return { kind: 'invalid' }
  return { kind: 'valid', country: upper }
}

export function isUnsupportedGeoCountry(code: string | null | undefined): boolean {
  const normalized = normalizeGeoCountryCode(code)
  return normalized.kind === 'valid' && GEO_BLOCKED_COUNTRIES.has(normalized.country)
}

export function isGeoUnsupportedError(error: unknown): boolean {
  let raw = ''
  if (error instanceof Error) {
    raw = error.message
  } else if (typeof error === 'string') {
    raw = error
  } else if (error && typeof error === 'object') {
    try {
      raw = JSON.stringify(error)
    } catch {
      raw = String(error)
    }
  } else {
    raw = String(error ?? '')
  }
  const lower = raw.toLowerCase()
  if (!lower) return false
  return (
    lower.includes('user location is not supported for the api use') ||
    (lower.includes('failed_precondition') && lower.includes('location is not supported'))
  )
}

function parseIpv4Octets(text: string): [string, string, string, string] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
  }
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

/**
 * Masks the host portion of an IPv4 or IPv6 address so screenshots/UI never leak full public IPs.
 * Browser-safe pure implementation (no `node:*` imports).
 */
export function maskIpAddress(ip: string | null | undefined): string {
  if (typeof ip !== 'string') return 'unknown'
  let cleaned = ip.trim()
  if (!cleaned) return 'unknown'

  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1).trim()
  }
  const zoneIdx = cleaned.indexOf('%')
  if (zoneIdx !== -1) {
    cleaned = cleaned.slice(0, zoneIdx)
  }
  if (!cleaned) return 'unknown'

  const v4 = parseIpv4Octets(cleaned)
  if (v4) {
    return `${v4[0]}.${v4[1]}.${v4[2]}.*`
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:203.0.113.42)
  if (/^::ffff:/i.test(cleaned)) {
    const mapped = parseIpv4Octets(cleaned.slice(7))
    if (mapped) {
      return `::ffff:${mapped[0]}.${mapped[1]}.${mapped[2]}.*`
    }
  }

  // Pure IPv6 validation and canonical prefix extraction
  if (!cleaned.includes(':')) return 'unknown'
  const doubleColonParts = cleaned.split('::')
  if (doubleColonParts.length > 2) return 'unknown'

  const left = doubleColonParts[0] ? doubleColonParts[0].split(':') : []
  const right = doubleColonParts.length === 2 && doubleColonParts[1] ? doubleColonParts[1].split(':') : []

  const isHexGroup = (g: string): boolean => /^[0-9a-fA-F]{1,4}$/.test(g)
  if (!left.every(isHexGroup) || !right.every(isHexGroup)) return 'unknown'

  let groups: string[]
  if (doubleColonParts.length === 2) {
    const missing = 8 - left.length - right.length
    if (missing < 1) return 'unknown'
    groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  } else {
    if (left.length !== 8) return 'unknown'
    groups = left
  }

  const g0 = Number.parseInt(groups[0]!, 16).toString(16)
  const g1 = Number.parseInt(groups[1]!, 16).toString(16)
  return `${g0}:${g1}::*`
}
