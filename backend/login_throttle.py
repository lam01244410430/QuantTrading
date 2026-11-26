from asyncio import timeout
from dataclasses import dataclass
from hashlib import sha256
from ipaddress import IPv4Network, IPv6Address, IPv6Network, ip_address, ip_network
from os import environ

from starlette.requests import Request

DEFAULT_LIMIT = 10
DEFAULT_WINDOW_SECONDS = 60
GLOBAL_LIMIT = 120
HASH_CONCURRENCY = 2
FORWARDED_LIMIT = 2048
PREFIX = "qt:{login}:"

ADMIT = """
local peer_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local global_count = tonumber(redis.call('GET', KEYS[2]) or '0')
local retry = 0
if peer_count >= tonumber(ARGV[1]) then
    retry = math.max(1, math.ceil(redis.call('PTTL', KEYS[1]) / 1000))
end
if global_count >= tonumber(ARGV[2]) then
    retry = math.max(retry, 1, math.ceil(redis.call('PTTL', KEYS[2]) / 1000))
end
if retry > 0 then
    return retry
end
for _, key in ipairs(KEYS) do
    if redis.call('INCR', key) == 1 then
        redis.call('EXPIRE', key, ARGV[3])
    end
end
return 0
"""


@dataclass(frozen=True)
class LoginThrottle:
    limit: int
    window_seconds: int
    trusted_proxies: tuple[IPv4Network | IPv6Network, ...] = ()

    @classmethod
    def from_env(cls):
        proxies = environ.get("QT_TRUSTED_PROXY_CIDRS", "")
        return cls(
            bounded_setting("QT_LOGIN_LIMIT", DEFAULT_LIMIT, GLOBAL_LIMIT),
            bounded_setting("QT_LOGIN_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS, 3600),
            tuple(ip_network(value.strip()) for value in proxies.split(",") if value.strip()),
        )

    def is_trusted(self, address):
        return any(address in network for network in self.trusted_proxies)

    def client_key(self, request: Request) -> str:
        try:
            peer = normalized_address(request.client.host if request.client else "")
        except ValueError:
            return "unknown"
        if self.is_trusted(peer):
            for hop in forwarded_tail(request.headers.getlist("x-forwarded-for")):
                try:
                    address = normalized_address(hop.strip())
                except ValueError:
                    break
                if not self.is_trusted(address):
                    return str(address)
            return "invalid-forwarded"
        return str(peer)

    async def retry_after(self, redis, request: Request) -> int:
        key = sha256(self.client_key(request).encode()).hexdigest()
        async with timeout(1):
            return await redis.eval(
                ADMIT, 2, PREFIX + key, PREFIX + "global", self.limit, GLOBAL_LIMIT, self.window_seconds,
            )


def forwarded_tail(headers):
    remaining = FORWARDED_LIMIT
    for header in reversed(headers):
        if len(header) > remaining:
            tail = header[-remaining:]
            if header[-remaining - 1] != ",":
                _, _, tail = tail.partition(",")
            if tail:
                yield from reversed(tail.split(","))
            return
        yield from reversed(header.split(","))
        remaining -= len(header) + 1
        if remaining <= 0:
            return


def normalized_address(value):
    address = ip_address(value)
    if isinstance(address, IPv6Address):
        return address.ipv4_mapped or IPv6Address(int(address))
    return address


def bounded_setting(name, default, maximum):
    value = int(environ.get(name, default))
    if not 1 <= value <= maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return value
