const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// Fixed O(1) storage for the single-admin sign-in endpoint (no unbounded per-header map).
let attemptTimestamps: number[] = [];

function pruneExpired(now: number): void {
  attemptTimestamps = attemptTimestamps.filter((t) => now - t < WINDOW_MS);
}

/**
 * Synchronously reserves a sign-in attempt slot before awaiting upstream auth,
 * preventing concurrent in-flight requests from bypassing the limit.
 */
export function consumeLoginAttempt(
  now = Date.now()
): { allowed: true; token: number } | { allowed: false; retryAfterSeconds: number } {
  pruneExpired(now);
  if (attemptTimestamps.length >= MAX_ATTEMPTS) {
    const oldest = attemptTimestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  attemptTimestamps.push(now);
  return { allowed: true, token: now };
}

/**
 * Refunds a reserved attempt slot if the upstream service was unavailable (5xx)
 * rather than rejecting credentials.
 */
export function refundLoginAttempt(token: number): void {
  const idx = attemptTimestamps.lastIndexOf(token);
  if (idx !== -1) {
    attemptTimestamps.splice(idx, 1);
  }
}

export function clearLoginRateLimit(): void {
  attemptTimestamps = [];
}

export function resetLoginRateLimitForTests(): void {
  attemptTimestamps = [];
}
