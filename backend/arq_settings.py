import json

from arq import cron

from . import runs, worker


class WorkerSettings:
    functions = [worker.run_backtest]
    cron_jobs = [cron(worker.reconcile, second=set(range(0, 60, runs.REAP_INTERVAL)))]
    on_startup = worker.startup
    on_shutdown = worker.shutdown
    job_timeout = runs.JOB_TIMEOUT + 5
    max_tries = 1
    retry_jobs = False
    max_jobs = 4
    keep_result = runs.QUEUE_TTL
    health_check_interval = 5
    job_serializer = runs.serialize_job
    job_deserializer = json.loads
    redis_settings = runs.redis_settings()
