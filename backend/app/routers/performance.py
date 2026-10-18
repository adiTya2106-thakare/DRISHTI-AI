# Drishti AI – /api/performance endpoint
# Returns real measured latency from database.
# CPU/memory only if psutil is installed — never fabricated.

from __future__ import annotations
from fastapi import APIRouter
from app.models.schemas import PerformanceResponse, LatencyStats
from app.db.database import get_db
import statistics

router = APIRouter()


def _compute_stats(values: list[float]) -> LatencyStats:
    if not values:
        return LatencyStats(count=0, medianMs=None, p95Ms=None, minMs=None, maxMs=None, avgMs=None)
    sorted_vals = sorted(values)
    p95_idx = int(len(sorted_vals) * 0.95)
    return LatencyStats(
        count=len(values),
        medianMs=round(statistics.median(values), 1),
        p95Ms=round(sorted_vals[min(p95_idx, len(sorted_vals) - 1)], 1),
        minMs=round(min(values), 1),
        maxMs=round(max(values), 1),
        avgMs=round(statistics.mean(values), 1),
    )


@router.get("/performance", response_model=PerformanceResponse)
async def get_performance() -> PerformanceResponse:
    """
    Return real performance measurements from the database.
    CPU/memory reported only if psutil is available — otherwise None.
    Never fabricates metrics.
    """
    async with get_db() as db:
        # Task latency from completed tasks
        cursor = await db.execute(
            "SELECT duration_ms FROM tasks WHERE status = 'completed' AND duration_ms IS NOT NULL"
        )
        task_durations = [row[0] for row in await cursor.fetchall()]

        # Inference latency from performance events
        cursor = await db.execute(
            "SELECT latency_ms FROM performance_events WHERE latency_ms IS NOT NULL"
        )
        inference_latencies = [row[0] for row in await cursor.fetchall()]

        # Task counts
        cursor = await db.execute("SELECT COUNT(*) FROM tasks")
        total_tasks = (await cursor.fetchone())[0]

        cursor = await db.execute("SELECT COUNT(*) FROM tasks WHERE status = 'completed'")
        completed = (await cursor.fetchone())[0]

        cursor = await db.execute("SELECT COUNT(*) FROM tasks WHERE status = 'failed'")
        failed = (await cursor.fetchone())[0]

        # Blocked requests
        cursor = await db.execute(
            "SELECT COUNT(*) FROM privacy_events WHERE gate_allowed = 0"
        )
        blocked = (await cursor.fetchone())[0]

    # Success rate — only reported when there is latency data (i.e., tasks that ran
    # end-to-end and had duration measured).  Without latency data the rate is None
    # rather than a potentially misleading 0.0 or partial fraction.
    terminal_tasks = completed + failed
    success_rate = None
    if terminal_tasks > 0 and len(task_durations) > 0:
        success_rate = round(completed / terminal_tasks, 3)

    # CPU/memory — only if psutil available
    cpu_percent = None
    memory_mb = None
    psutil_note = "CPU/memory not measured — install psutil to enable resource monitoring."
    try:
        import psutil
        cpu_percent = round(psutil.cpu_percent(interval=0.1), 1)
        memory_mb = round(psutil.Process().memory_info().rss / 1024 / 1024, 1)
        psutil_note = "CPU/memory measured via psutil (backend process only; does not include browser)."
    except ImportError:
        pass

    note_parts = [
        "Latency measurements are from completed tasks stored in SQLite.",
        psutil_note,
        "Task success rate based on tasks that reached completed/failed status.",
    ]

    return PerformanceResponse(
        taskLatency=_compute_stats([float(d) for d in task_durations]),
        inferenceLatency=_compute_stats(inference_latencies),
        taskSuccessRate=success_rate,
        blockedRequestsCount=blocked,
        totalTasksCount=total_tasks,
        completedTasksCount=completed,
        failedTasksCount=failed,
        cpuPercent=cpu_percent,
        memoryMB=memory_mb,
        note=" ".join(note_parts),
    )
