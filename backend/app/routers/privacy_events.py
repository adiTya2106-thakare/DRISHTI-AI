# Drishti AI – /api/privacy/events endpoint

from __future__ import annotations
from fastapi import APIRouter, Query
from app.models.schemas import (
    PrivacyEventsResponse, PrivacyEventItem, PrivacyEventRequest,
)
from app.db.database import get_db
from app.services.ws_manager import ws_manager
import uuid
import time
import json

router = APIRouter()


@router.get("/events", response_model=PrivacyEventsResponse)
async def get_privacy_events(
    limit: int = Query(100, ge=1, le=500),
    session_id: str | None = Query(None),
) -> PrivacyEventsResponse:
    """
    Return privacy audit events — detection counts, gate decisions, blocked requests.
    No raw PII values are stored or returned.
    """
    async with get_db() as db:
        if session_id:
            cursor = await db.execute(
                "SELECT COUNT(*) FROM privacy_events WHERE session_id = ?",
                (session_id,),
            )
        else:
            cursor = await db.execute("SELECT COUNT(*) FROM privacy_events")
        total = (await cursor.fetchone())[0]

        if session_id:
            cursor = await db.execute(
                """SELECT * FROM privacy_events WHERE session_id = ?
                   ORDER BY created_at DESC LIMIT ?""",
                (session_id, limit),
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM privacy_events ORDER BY created_at DESC LIMIT ?",
                (limit,),
            )
        rows = await cursor.fetchall()

        # Aggregates
        agg = await db.execute(
            "SELECT SUM(count) as td, SUM(masked_count) as tm FROM privacy_events"
        )
        agg_row = await agg.fetchone()
        total_detections = agg_row["td"] or 0
        total_masked = agg_row["tm"] or 0

        blocked_cursor = await db.execute(
            "SELECT COUNT(*) FROM privacy_events WHERE gate_allowed = 0"
        )
        total_blocked = (await blocked_cursor.fetchone())[0]

    events = [
        PrivacyEventItem(
            id=row["id"],
            sessionId=row["session_id"],
            taskId=row["task_id"],
            eventType=row["event_type"],
            categories=json.loads(row["categories"] or "[]"),
            count=row["count"] or 0,
            maskedCount=row["masked_count"] or 0,
            gateAllowed=bool(row["gate_allowed"]) if row["gate_allowed"] is not None else None,
            gateReason=row["gate_reason"],
            blockedCategories=json.loads(row["blocked_categories"] or "[]"),
            payloadSizeBytes=row["payload_size_bytes"],
            method=row["method"],
            createdAt=row["created_at"],
        )
        for row in rows
    ]

    return PrivacyEventsResponse(
        events=events,
        total=total,
        totalDetections=total_detections,
        totalMasked=total_masked,
        totalBlocked=total_blocked,
    )


@router.post("/events", status_code=201)
async def record_privacy_event(body: PrivacyEventRequest) -> dict:
    """
    Record a privacy detection or gate decision event.
    Called by the extension after each privacy gate check.
    No raw PII values accepted.
    """
    now = int(time.time() * 1000)
    event_id = str(uuid.uuid4())

    async with get_db() as db:
        await db.execute(
            """INSERT INTO privacy_events
               (id, session_id, task_id, event_type,
                categories, count, masked_count,
                gate_allowed, gate_reason, blocked_categories,
                payload_size_bytes, method, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event_id,
                body.sessionId,
                body.taskId,
                body.eventType,
                json.dumps(body.categories),
                body.count,
                body.maskedCount,
                int(body.gateAllowed) if body.gateAllowed is not None else None,
                body.gateReason,
                json.dumps(body.blockedCategories),
                body.payloadSizeBytes,
                body.method,
                now,
            ),
        )
        await db.commit()

    # Push live update
    await ws_manager.send_to_session(
        body.sessionId,
        "privacy_event",
        {
            "eventType": body.eventType,
            "categories": body.categories,
            "count": body.count,
            "maskedCount": body.maskedCount,
            "gateAllowed": body.gateAllowed,
            "timestamp": now,
        },
    )

    return {"ok": True, "eventId": event_id}
