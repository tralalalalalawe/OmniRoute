/** How long a provider's latest failure may remain the Home topology error. */
export const DEFAULT_TOPOLOGY_ERROR_WINDOW_HOURS = 24;

export const TOPOLOGY_ERROR_WINDOW_MS = DEFAULT_TOPOLOGY_ERROR_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * `OMNIROUTE_TOPOLOGY_ERROR_WINDOW_HOURS`. Empty, zero, and non-numeric values
 * keep the 24 hour default. A positive number is the window length in hours.
 */
export function resolveTopologyErrorWindowMs(raw: string | undefined | null): number {
  if (raw == null) return TOPOLOGY_ERROR_WINDOW_MS;
  const trimmed = raw.trim();
  if (!trimmed) return TOPOLOGY_ERROR_WINDOW_MS;
  const hours = Number(trimmed);
  if (!Number.isFinite(hours) || hours <= 0) return TOPOLOGY_ERROR_WINDOW_MS;
  return hours * 60 * 60 * 1000;
}

/**
 * A failure counts only when it is inside the window and the call belongs to a
 * connection that is still active. A blank connection id falls back to "this
 * provider still has an active connection". A no-auth or deleted connection id
 * does not.
 */
export function isCurrentActiveFailure(input: {
  connectionId: string | null | undefined;
  provider: string;
  failedAtMs: number;
  nowMs: number;
  windowMs: number;
  activeConnectionProviders: ReadonlyMap<string, string>;
  providersWithActiveConnection: ReadonlySet<string>;
}): boolean {
  if (!Number.isFinite(input.failedAtMs) || input.failedAtMs <= 0) return false;
  if (input.nowMs - input.failedAtMs > input.windowMs) return false;
  const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  if (!connectionId) return input.providersWithActiveConnection.has(input.provider);
  return input.activeConnectionProviders.get(connectionId) === input.provider;
}
