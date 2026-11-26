import { AsyncLocalStorage } from "node:async_hooks";
import { normalizePeerAddress } from "../../proxy-peer.mjs";

export { normalizePeerAddress };

export interface RequestPeerContext {
  clientPeerIp: string | null;
  fromTrustedProxy: boolean;
}

const PEER_STORE_SYMBOL = Symbol.for("quanttrading.socketPeerStore");

type GlobalWithPeerStore = typeof globalThis & {
  [PEER_STORE_SYMBOL]?: AsyncLocalStorage<RequestPeerContext>;
};

function getPeerStore(): AsyncLocalStorage<RequestPeerContext> {
  const g = globalThis as GlobalWithPeerStore;
  if (!g[PEER_STORE_SYMBOL]) {
    g[PEER_STORE_SYMBOL] = new AsyncLocalStorage<RequestPeerContext>();
  }
  return g[PEER_STORE_SYMBOL];
}

/**
 * Returns the resolved client peer IP for the current request, populated only by
 * web/server.mjs (using the real TCP socket peer, or the rightmost untrusted XFF hop
 * when the socket peer is inside QT_WEB_TRUSTED_PROXY_CIDRS).
 */
export function getSocketPeer(): string | null {
  const ctx = getPeerStore().getStore();
  return normalizePeerAddress(ctx?.clientPeerIp);
}

/**
 * Returns true only when web/server.mjs verified that the direct TCP socket peer
 * belongs to QT_WEB_TRUSTED_PROXY_CIDRS.
 */
export function isTrustedProxyRequest(): boolean {
  return getPeerStore().getStore()?.fromTrustedProxy === true;
}

/**
 * Runs a function with a bound request peer context in AsyncLocalStorage.
 */
export function runWithRequestPeer<T>(
  context: {
    clientPeerIp: string | null | undefined;
    fromTrustedProxy?: boolean;
  },
  fn: () => T
): T {
  return getPeerStore().run(
    {
      clientPeerIp: normalizePeerAddress(context.clientPeerIp),
      fromTrustedProxy: context.fromTrustedProxy === true,
    },
    fn
  );
}

/**
 * Convenience helper for running with an untrusted direct socket peer IP.
 */
export function runWithSocketPeer<T>(
  peerIp: string | null | undefined,
  fn: () => T
): T {
  return runWithRequestPeer({ clientPeerIp: peerIp, fromTrustedProxy: false }, fn);
}
