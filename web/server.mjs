import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { isIP } from "node:net";
import next from "next";

const PEER_STORE_SYMBOL = Symbol.for("quanttrading.socketPeerStore");
const peerStore =
  globalThis[PEER_STORE_SYMBOL] ?? new AsyncLocalStorage();
globalThis[PEER_STORE_SYMBOL] = peerStore;

function normalizePeerAddress(raw) {
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

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = http.createServer((req, res) => {
      const peer = normalizePeerAddress(req.socket?.remoteAddress);
      peerStore.run(peer, () => {
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
