export function clampInteger(
  value: number | undefined,
  minValue: number,
  maxValue: number,
  defaultValue: number
): number {
  if (!Number.isFinite(value)) return defaultValue
  const rounded = Math.floor(value as number)
  if (rounded < minValue) return minValue
  if (rounded > maxValue) return maxValue
  return rounded
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// tg: is the Telegram client's deep-link scheme, used by message links in
// Markdown reports.
const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'tg:'])

export function normalizeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    const url = new URL(trimmed)
    if (!EXTERNAL_URL_PROTOCOLS.has(url.protocol)) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}
