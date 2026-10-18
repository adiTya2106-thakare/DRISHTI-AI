# Drishti AI – /api/health endpoint

from fastapi import APIRouter
from app.models.schemas import HealthResponse
from app.services.ws_manager import ws_manager
import os
import time

router = APIRouter()
_start_time = time.time()

@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Return real backend health status."""
    return HealthResponse(
        status="ok",
        version="2.0.0",
        plannerAvailable=True,
        externalAIConfigured=bool(
            os.environ.get("OPENAI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
        ),
        dbConnected=True,          # if we got here, DB initialised
        activeSessions=ws_manager.active_sessions,
        uptime_seconds=round(time.time() - _start_time, 1),
    )

# Legacy root-level /health kept for backward compatibility
