export const FORWARDED_LIMIT: number;

export interface ParsedAddress {
  family: 4 | 6;
  value: bigint;
  canonical: string;
}

export interface ParsedCidr {
  family: 4 | 6;
  network: bigint;
  mask: bigint;
  prefixLen: number;
}

export interface ResolvedClientPeer {
  clientPeerIp: string | null;
  fromTrustedProxy: boolean;
}

export function parseAddress(raw: string | null | undefined): ParsedAddress | null;
export function normalizePeerAddress(raw: string | null | undefined): string | null;
export function parseCidr(raw: string): ParsedCidr;
export function parseTrustedProxyCidrs(raw: string | null | undefined): ParsedCidr[];
export function isAddressTrusted(
  address: ParsedAddress | null,
  trustedCidrs: ParsedCidr[]
): boolean;
export function forwardedTail(
  headers: string | string[] | null | undefined
): Generator<string, void, unknown>;
export function extractXForwardedForHeaders(req: {
  rawHeaders?: string[];
  headers?: Record<string, string | string[] | undefined>;
}): string[];
export function resolveClientPeer(options: {
  remoteAddress: string | null | undefined;
  xForwardedForHeaders?: string | string[] | null | undefined;
  trustedCidrs?: ParsedCidr[];
}): ResolvedClientPeer;
