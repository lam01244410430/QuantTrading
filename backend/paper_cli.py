import argparse
import asyncio
import json
from datetime import datetime, timezone
from uuid import uuid4

from arq import create_pool

from . import paper, runs
from .database import create_engine


async def run(command, consumer, max_deliveries, relay_ack_timeout):
    engine = create_engine()
    try:
        if command == "replay":
            source = paper.replay_source()
            count = await paper.replay_candle(engine, source[-1], source)
            return {"new_close_events": count}
        if command == "execute":
            return {"new_paper_fills": await paper.execute_paper(engine)}
        if command == "report":
            return {"orders": await paper.paper_report(engine)}
        redis = await create_pool(runs.redis_settings())
        try:
            if command == "relay":
                count = 0
                as_of = datetime.now(timezone.utc)
                while await paper.relay_next(engine, redis, ack_timeout=relay_ack_timeout, as_of=as_of):
                    count += 1
                return {"published_events": count}
            return {"acknowledged_events": await paper.consume(engine, redis, consumer, max_deliveries=max_deliveries)}
        finally:
            await redis.aclose()
    finally:
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description="Run one stage of the offline synthetic paper replay.")
    parser.add_argument("command", choices=["replay", "relay", "strategy", "execute", "report"])
    parser.add_argument("--consumer", default=f"paper-{uuid4()}")
    parser.add_argument("--max-deliveries", type=int, default=paper.MAX_DELIVERIES)
    parser.add_argument("--relay-ack-timeout", type=int, default=paper.RELAY_ACK_TIMEOUT, metavar="SECONDS")
    args = parser.parse_args()
    result = asyncio.run(run(args.command, args.consumer, args.max_deliveries, args.relay_ack_timeout))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
