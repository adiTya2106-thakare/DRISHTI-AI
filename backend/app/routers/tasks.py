# Drishti AI – /api/tasks router (task history + events)
# Persists task metadata to SQLite — no raw PII stored.

from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import (
    TaskHistoryResponse, TaskHistoryItem, TaskEventRequest,
)
from app.db.database import get_db
from app.services.ws_manager import ws_manager
import uuid
import time
import json

router = APIRouter()


@router.get("", response_model=TaskHistoryResponse)
async def get_tasks(
    page: int = Query(1, ge=1, le=1000),
    page_size: int = Query(20, ge=1, le=100),
    session_id: str | None = Query(None),
) -> TaskHistoryResponse:
    """Return recent task history. Sanitized task text only — no raw PII."""
    offset = (page - 1) * page_size

    async with get_db() as db:
        if session_id:
            cursor = await db.execute(
                "SELECT COUNT(*) FROM tasks WHERE session_id = ?",
                (session_id,),
            )
        else:
            cursor = await db.execute("SELECT COUNT(*) FROM tasks")
        total = (await cursor.fetchone())[0]

        if session_id:
            cursor = await db.execute(
                """SELECT * FROM tasks WHERE session_id = ?
                   ORDER BY created_at DESC LIMIT ? OFFSET ?""",
                (session_id, page_size, offset),
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (page_size, offset),
            )
        rows = await cursor.fetchall()

    tasks = [
        TaskHistoryItem(
            id=row["id"],
            sessionId=row["session_id"],
            taskText=row["task_text"],
            status=row["status"],
            plannerUsed=row["planner_used"],
            stepsCount=row["steps_count"] or 0,
            privacyGateAllowed=bool(row["privacy_gate_allowed"]),
            detectionsCount=row["detections_count"] or 0,
            durationMs=row["duration_ms"],
            createdAt=row["created_at"],
            completedAt=row["completed_at"],
        )
        for row in rows
    ]

    return TaskHistoryResponse(tasks=tasks, total=total, page=page, pageSize=page_size)


@router.post("/{task_id}/events", status_code=201)
async def record_task_event(task_id: str, body: TaskEventRequest) -> dict:
    """
    Record a task execution event.
    Called by the extension after each action to persist results without storing PII.
    """
    if task_id != body.taskId:
        raise HTTPException(status_code=400, detail="task_id in path must match body.taskId")

    now = int(time.time() * 1000)

    async with get_db() as db:
        if body.eventType == "started":
            await db.execute(
                """INSERT OR IGNORE INTO tasks
                   (id, session_id, task_text, status, created_at)
                   VALUES (?, ?, ?, 'started', ?)""",
                (task_id, body.sessionId, "[task started]", now),
            )
        elif body.eventType in ("completed", "failed"):
            # Look up created_at for duration calculation
            cursor = await db.execute(
                "SELECT created_at FROM tasks WHERE id = ?", (task_id,)
            )
            row = await cursor.fetchone()
            duration = (now - row["created_at"]) if row else None

            await db.execute(
                """UPDATE tasks SET status = ?, completed_at = ?, duration_ms = ?
                   WHERE id = ?""",
                (body.eventType, now, duration, task_id),
            )
        elif body.eventType in ("action_executed", "action_failed"):
            event_id = str(uuid.uuid4())
            await db.execute(
                """INSERT INTO action_events
                   (id, session_id, task_id, action_type, success,
                    confirmation_required, confirmation_received,
                    error_message, latency_ms, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    event_id,
                    body.sessionId,
                    task_id,
                    body.actionType or "UNKNOWN",
                    int(body.success),
                    int(body.confirmationRequired),
                    int(body.confirmationReceived) if body.confirmationReceived is not None else None,
                    body.errorMessage,
                    body.latencyMs,
                    now,
                ),
            )
        await db.commit()

    # Push live update via WebSocket
    await ws_manager.send_to_session(
        body.sessionId,
        "task_event",
        {
            "taskId": task_id,
            "eventType": body.eventType,
            "success": body.success,
            "timestamp": now,
        },
    )

    return {"ok": True, "taskId": task_id, "eventType": body.eventType}


@router.delete("")
async def clear_task_history() -> dict:
    """Clear all task history (user-initiated only)."""
    async with get_db() as db:
        await db.execute("DELETE FROM tasks")
        await db.execute("DELETE FROM action_events")
        await db.commit()
    return {"ok": True, "message": "Task history cleared"}
