import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

const PEER_STORE_SYMBOL = Symbol.for("quanttrading.socketPeerStore");

type GlobalWithPeerStore = typeof globalThis & {
  [PEER_STORE_SYMBOL]?: AsyncLocalStorage<string | null>;
};

function getPeerStore(): AsyncLocalStorage<string | null> {
  const g = globalThis as GlobalWithPeerStore;
  if (!g[PEER_STORE_SYMBOL]) {
    g[PEER_STORE_SYMBOL] = new AsyncLocalStorage<string | null>();
  }
  return g[PEER_STORE_SYMBOL];
}

/**
 * Normalizes a TCP socket remote address (e.g. "::ffff:127.0.0.1" -> "127.0.0.1").
 * Rejects non-IP strings, comma-separated chains, or empty values.
 */
export function normalizePeerAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith("::ffff:")) {
    const mappedV4 = trimmed.slice(7);
    if (isIP(mappedV4) === 4) {
      return mappedV4;
    }
  }

  return isIP(trimmed) !== 0 ? trimmed : null;
}

/**
 * Returns the real TCP socket peer IP for the current request, populated only by
 * web/server.mjs from req.socket.remoteAddress (never from client HTTP headers).
 */
export function getSocketPeer(): string | null {
  const peer = getPeerStore().getStore();
  return normalizePeerAddress(peer);
}

/**
 * Runs a function with a bound socket peer IP in AsyncLocalStorage.
 */
export function runWithSocketPeer<T>(
  peerIp: string | null | undefined,
  fn: () => T
): T {
  return getPeerStore().run(normalizePeerAddress(peerIp), fn);
}
