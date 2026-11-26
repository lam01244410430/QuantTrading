const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;
const MAX_TRACKED_KEYS = 4096;

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

function prune(now: number) {
  if (store.size <= MAX_TRACKED_KEYS) return;
  for (const [key, entry] of store.entries()) {
    const active = entry.timestamps.filter((t) => now - t < WINDOW_MS);
    if (active.length === 0) {
      store.delete(key);
    } else {
      entry.timestamps = active;
    }
  }
}

export function checkLoginRateLimit(
  key: string,
  now = Date.now()
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const entry = store.get(key);
  if (!entry) return { allowed: true };

  const active = entry.timestamps.filter((t) => now - t < WINDOW_MS);
  if (active.length === 0) {
    store.delete(key);
    return { allowed: true };
  }
  entry.timestamps = active;

  if (active.length >= MAX_FAILED_ATTEMPTS) {
    const oldest = active[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true };
}

export function recordFailedLoginAttempt(key: string, now = Date.now()): void {
  prune(now);
  const entry = store.get(key);
  const active = entry ? entry.timestamps.filter((t) => now - t < WINDOW_MS) : [];
  active.push(now);
  store.set(key, { timestamps: active });
}

export function clearLoginRateLimit(key: string): void {
  store.delete(key);
}

export function resetLoginRateLimitForTests(): void {
  store.clear();
}
