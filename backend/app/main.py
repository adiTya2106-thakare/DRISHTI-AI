# Drishti AI Backend v2
# Full API server: health, system status, task planning, privacy events,
# performance metrics, benchmark runner, WebSocket live updates.
# SQLite persistence via aiosqlite. No raw PII logged anywhere.

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import time
import os
import logging

from app.routers import plan, health, tasks, privacy_events, performance, benchmark, system_status
from app.models.schemas import ErrorResponse
from app.db.database import init_db
from app.services.ws_manager import ws_manager

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("drishti")

# ─── Lifespan (DB init) ───────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(application: FastAPI):
    await init_db()
    logger.info("Drishti AI backend started — database initialised")
    yield
    logger.info("Drishti AI backend shutting down")

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Drishti AI Backend",
    description="Privacy-first browser agent — all endpoints accept sanitized context only.",
    version="2.0.0",
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

# ─── CORS ─────────────────────────────────────────────────────────────────────
# Restrict to localhost and the specific extension origins.
# In production, replace with the exact extension IDs.

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"chrome-extension://[a-z]{32}",   # specific extension IDs only
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Session-ID"],
    max_age=600,
)

# ─── Routers (all under /api prefix) ─────────────────────────────────────────

app.include_router(health.router,         prefix="/api",          tags=["Health"])
app.include_router(system_status.router,  prefix="/api/system",   tags=["System"])
app.include_router(plan.router,           prefix="/api/tasks",    tags=["Tasks"])
app.include_router(tasks.router,          prefix="/api/tasks",    tags=["Tasks"])
app.include_router(privacy_events.router, prefix="/api/privacy",  tags=["Privacy"])
app.include_router(performance.router,    prefix="/api",          tags=["Performance"])
app.include_router(benchmark.router,      prefix="/api/benchmark",tags=["Benchmark"])

# Legacy compatibility: keep /plan and /health at root level
app.include_router(health.router, tags=["Legacy"])
app.include_router(plan.legacy_router, prefix="/plan", tags=["Legacy"])

# ─── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await ws_manager.connect(session_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            # Echo back pings to keep alive; actual events pushed by other handlers
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(session_id)

# ─── Request logging (safe — body never logged) ───────────────────────────────

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    duration = (time.time() - start) * 1000
    logger.info(f"{request.method} {request.url.path} → {response.status_code} ({duration:.1f}ms)")
    return response

# ─── Error Handlers ───────────────────────────────────────────────────────────

@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(detail=exc.detail, code=str(exc.status_code)).model_dump(),
    )

@app.exception_handler(Exception)
async def generic_exception_handler(_request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {type(exc).__name__}: {exc}")
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(detail="Internal server error", code="500").model_dump(),
    )
