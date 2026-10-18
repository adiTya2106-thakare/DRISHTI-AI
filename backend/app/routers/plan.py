# Drishti AI – /api/tasks/plan endpoint + legacy /plan
# Accepts sanitized context, returns a validated structured action plan.
# Persists task metadata to SQLite — no raw PII stored.

from fastapi import APIRouter, HTTPException
from app.models.schemas import PlanRequest, PlanResponse
from app.services.planner import get_plan
from app.db.database import get_db
from app.services.ws_manager import ws_manager
import uuid
import time

router = APIRouter()
legacy_router = APIRouter()


async def _handle_plan(request_body: PlanRequest) -> PlanResponse:
    """Shared handler used by both /api/tasks/plan and legacy /plan."""
    if not request_body.sanitizedContext.privacyGateDecision.allowed:
        raise HTTPException(
            status_code=400,
            detail="Privacy gate did not allow this context."
        )

    plan_start = time.time()
    try:
        plan = await get_plan(request_body)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Planner error: {type(e).__name__}")

    latency_ms = int((time.time() - plan_start) * 1000)

    # Validate before returning
    validated_plan = PlanResponse(**plan.model_dump())

    # Persist task to DB (sanitized task text only, no PII)
    task_id = validated_plan.planId
    now = int(time.time() * 1000)
    async with get_db() as db:
        await db.execute(
            """INSERT OR IGNORE INTO tasks
               (id, session_id, task_text, status, planner_used,
                steps_count, privacy_gate_allowed, detections_count, created_at)
               VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?)""",
            (
                task_id,
                request_body.sessionId,
                request_body.taskText[:500],   # sanitized — already through privacy gate
                validated_plan.plannerUsed,
                len(validated_plan.steps),
                int(request_body.sanitizedContext.privacyGateDecision.allowed),
                len(request_body.sanitizedContext.detections),
                now,
            ),
        )
        # Persist performance event
        await db.execute(
            """INSERT INTO performance_events
               (id, session_id, task_id, event_type, model_name, backend, latency_ms, success, created_at)
               VALUES (?, ?, ?, 'planning', ?, ?, ?, 1, ?)""",
            (
                str(uuid.uuid4()),
                request_body.sessionId,
                task_id,
                validated_plan.plannerUsed,
                "remote" if "openai" in validated_plan.plannerUsed or "anthropic" in validated_plan.plannerUsed else "deterministic",
                float(latency_ms),
                now,
            ),
        )
        await db.commit()

    # Push live update
    await ws_manager.send_to_session(
        request_body.sessionId,
        "plan_ready",
        {
            "planId": task_id,
            "stepsCount": len(validated_plan.steps),
            "plannerUsed": validated_plan.plannerUsed,
            "latencyMs": latency_ms,
        },
    )

    return validated_plan


# New API route
@router.post("/plan", response_model=PlanResponse)
async def create_plan(request_body: PlanRequest) -> PlanResponse:
    """
    Generate a structured action plan from sanitized page context.
    Privacy gate must have passed client-side before calling this endpoint.
    """
    return await _handle_plan(request_body)


# Legacy route for backward compatibility with existing extension code
@legacy_router.post("", response_model=PlanResponse)
async def create_plan_legacy(request_body: PlanRequest) -> PlanResponse:
    """Legacy /plan endpoint — identical to /api/tasks/plan."""
    return await _handle_plan(request_body)
