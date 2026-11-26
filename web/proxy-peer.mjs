import { isIP } from "node:net";

export const FORWARDED_LIMIT = 2048;

const IPV4_MAPPED_PREFIX = 0xffffn << 32n;
const IPV4_MASK = 0xffffffffn;
const IPV6_MASK = (1n << 128n) - 1n;

function formatIPv4(value) {
  return [
    Number((value >> 24n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number(value & 0xffn),
  ].join(".");
}

function parseIPv4Strict(raw) {
  if (isIP(raw) !== 4) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return { family: 4, value, canonical: formatIPv4(value) };
}

function formatIPv6(value) {
  const groups = [];
  for (let i = 7; i >= 0; i -= 1) {
    groups.push(Number((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  }

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) {
    return groups.join(":");
  }
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

function parseIPv6Raw(raw) {
  if (isIP(raw) !== 6) return null;
  if (raw.includes("%")) return null;

  let text = raw.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4Part = text.slice(lastColon + 1);
    const parsedV4 = parseIPv4Strict(v4Part);
    if (!parsedV4) return null;
    const hi = Number((parsedV4.value >> 16n) & 0xffffn).toString(16);
    const lo = Number(parsedV4.value & 0xffffn).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let fullGroups;
  if (halves.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    fullGroups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    if (left.length !== 8) return null;
    fullGroups = left;
  }

  let value = 0n;
  for (const g of fullGroups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/**
 * Parses and normalizes an IP address (mirroring backend/login_throttle.py):
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) normalize to IPv4.
 */
export function parseAddress(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const v4 = parseIPv4Strict(trimmed);
  if (v4) return v4;

  const v6Val = parseIPv6Raw(trimmed);
  if (v6Val === null) return null;

  if ((v6Val >> 32n) === 0xffffn) {
    const mappedV4 = v6Val & IPV4_MASK;
    return { family: 4, value: mappedV4, canonical: formatIPv4(mappedV4) };
  }

  return { family: 6, value: v6Val, canonical: formatIPv6(v6Val) };
}

export function normalizePeerAddress(raw) {
  return parseAddress(raw)?.canonical ?? null;
}

function makeMask(bits, prefixLen) {
  if (prefixLen === 0) return 0n;
  const full = bits === 32 ? IPV4_MASK : IPV6_MASK;
  return (full << BigInt(bits - prefixLen)) & full;
}

/**
 * Parses a single IP or CIDR (strict: host bits must be zero).
 * IPv4-mapped IPv6 networks with prefix >= 96 normalize to IPv4 networks,
 * mirroring normalized_network() in backend/login_throttle.py.
 */
export function parseCidr(raw) {
  if (typeof raw !== "string") {
    throw new Error("CIDR entry must be a string");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("CIDR entry must not be empty");
  }

  const slashIdx = trimmed.indexOf("/");
  const hasPrefix = slashIdx !== -1;
  const ipPart = hasPrefix ? trimmed.slice(0, slashIdx) : trimmed;
  const prefixPart = hasPrefix ? trimmed.slice(slashIdx + 1) : null;

  const v4 = parseIPv4Strict(ipPart);
  if (v4) {
    const prefixLen = hasPrefix ? Number(prefixPart) : 32;
    if (
      hasPrefix &&
      (!/^(0|[1-9][0-9]?)$/.test(prefixPart) || prefixLen < 0 || prefixLen > 32)
    ) {
      throw new Error(`Invalid IPv4 CIDR prefix in "${trimmed}"`);
    }
    const mask = makeMask(32, prefixLen);
    if ((v4.value & mask) !== v4.value) {
      throw new Error(`CIDR "${trimmed}" has host bits set`);
    }
    return { family: 4, network: v4.value, mask, prefixLen };
  }

  const v6Val = parseIPv6Raw(ipPart);
  if (v6Val !== null) {
    const prefixLen = hasPrefix ? Number(prefixPart) : 128;
    if (
      hasPrefix &&
      (!/^(0|[1-9][0-9]{0,2})$/.test(prefixPart) || prefixLen < 0 || prefixLen > 128)
    ) {
      throw new Error(`Invalid IPv6 CIDR prefix in "${trimmed}"`);
    }
    const mask = makeMask(128, prefixLen);
    if ((v6Val & mask) !== v6Val) {
      throw new Error(`CIDR "${trimmed}" has host bits set`);
    }
    if (prefixLen >= 96 && (v6Val >> 32n) === (IPV4_MAPPED_PREFIX >> 32n)) {
      const mappedV4 = v6Val & IPV4_MASK;
      const v4Prefix = prefixLen - 96;
      const v4Mask = makeMask(32, v4Prefix);
      return { family: 4, network: mappedV4, mask: v4Mask, prefixLen: v4Prefix };
    }
    return { family: 6, network: v6Val, mask, prefixLen };
  }

  throw new Error(`Invalid IP or CIDR "${trimmed}"`);
}

export function parseTrustedProxyCidrs(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseCidr);
}

export function isAddressTrusted(address, trustedCidrs) {
  if (!address || !trustedCidrs || trustedCidrs.length === 0) return false;
  for (const cidr of trustedCidrs) {
    if (
      cidr.family === address.family &&
      (address.value & cidr.mask) === cidr.network
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Mirrors forwarded_tail() in backend/login_throttle.py:
 * walks X-Forwarded-For header values from right to left, bounded to FORWARDED_LIMIT chars.
 */
export function* forwardedTail(headers) {
  const list = Array.isArray(headers)
    ? headers
    : typeof headers === "string"
      ? [headers]
      : [];

  let remaining = FORWARDED_LIMIT;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const header = list[i];
    if (typeof header !== "string") continue;
    if (header.length > remaining) {
      let tail = header.slice(-remaining);
      if (header[header.length - remaining - 1] !== ",") {
        const commaIdx = tail.indexOf(",");
        tail = commaIdx === -1 ? "" : tail.slice(commaIdx + 1);
      }
      if (tail) {
        const parts = tail.split(",");
        for (let j = parts.length - 1; j >= 0; j -= 1) {
          yield parts[j];
        }
      }
      return;
    }
    const parts = header.split(",");
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      yield parts[j];
    }
    remaining -= header.length + 1;
    if (remaining <= 0) {
      return;
    }
  }
}

/**
 * Extracts all X-Forwarded-For header values in wire order from a Node IncomingMessage.
 */
export function extractXForwardedForHeaders(req) {
  if (Array.isArray(req?.rawHeaders)) {
    const values = [];
    for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === "x-forwarded-for") {
        values.push(req.rawHeaders[i + 1]);
      }
    }
    return values;
  }
  const h = req?.headers?.["x-forwarded-for"];
  if (Array.isArray(h)) return h;
  if (typeof h === "string") return [h];
  return [];
}

/**
 * Resolves the effective client IP and whether the direct TCP peer is a trusted web proxy.
 * Mirrors LoginThrottle.client_key() in backend/login_throttle.py:
 * - Untrusted peer: ignores X-Forwarded-For and returns the normalized socket peer.
 * - Trusted peer: returns the rightmost untrusted hop in X-Forwarded-For (bounded to 2048 chars),
 *   or clientPeerIp: null (fail closed) if XFF is missing, malformed, or contains only trusted hops.
 */
export function resolveClientPeer({
  remoteAddress,
  xForwardedForHeaders = [],
  trustedCidrs = [],
}) {
  const peer = parseAddress(remoteAddress);
  if (!peer) {
    return { clientPeerIp: null, fromTrustedProxy: false };
  }

  if (isAddressTrusted(peer, trustedCidrs)) {
    for (const hop of forwardedTail(xForwardedForHeaders)) {
      const addr = parseAddress(hop);
      if (!addr) {
        break;
      }
      if (!isAddressTrusted(addr, trustedCidrs)) {
        return { clientPeerIp: addr.canonical, fromTrustedProxy: true };
      }
    }
    return { clientPeerIp: null, fromTrustedProxy: true };
  }

  return { clientPeerIp: peer.canonical, fromTrustedProxy: false };
}
