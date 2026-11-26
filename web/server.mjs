import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import next from "next";
import {
  extractXForwardedForHeaders,
  parseTrustedProxyCidrs,
  resolveClientPeer,
} from "./proxy-peer.mjs";

const PEER_STORE_SYMBOL = Symbol.for("quanttrading.socketPeerStore");
const peerStore =
  globalThis[PEER_STORE_SYMBOL] ?? new AsyncLocalStorage();
globalThis[PEER_STORE_SYMBOL] = peerStore;

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}
const dev = process.env.NODE_ENV === "development";
const hostname = process.env.HOSTNAME || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3000", 10);
const trustedProxyCidrs = parseTrustedProxyCidrs(
  process.env.QT_WEB_TRUSTED_PROXY_CIDRS || ""
);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = http.createServer((req, res) => {
      const resolved = resolveClientPeer({
        remoteAddress: req.socket?.remoteAddress,
        xForwardedForHeaders: extractXForwardedForHeaders(req),
        trustedCidrs: trustedProxyCidrs,
      });
      peerStore.run(resolved, () => {
        handle(req, res);
      });
    });

    server.listen(port, hostname, () => {
      console.log(`QuantTrading BFF listening on http://${hostname}:${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start QuantTrading BFF server:", err);
    process.exit(1);
  });
