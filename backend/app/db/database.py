# Drishti AI – SQLite database layer using aiosqlite

from __future__ import annotations
import aiosqlite
import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path

logger = logging.getLogger("drishti.db")

DB_PATH = os.environ.get("DRISHTI_DB_PATH", "drishti.db")

CREATE_TASKS_TABLE = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_text TEXT NOT NULL,        -- sanitized task text only
    status TEXT NOT NULL DEFAULT 'started',
    planner_used TEXT,
    steps_count INTEGER DEFAULT 0,
    privacy_gate_allowed INTEGER DEFAULT 1,
    detections_count INTEGER DEFAULT 0,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
)
"""

CREATE_PRIVACY_EVENTS_TABLE = """
CREATE TABLE IF NOT EXISTS privacy_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT,
    event_type TEXT NOT NULL,
    -- NOTE: no raw PII values stored — only categories and counts
    categories TEXT,               -- JSON array of category strings
    count INTEGER DEFAULT 0,
    masked_count INTEGER DEFAULT 0,
    gate_allowed INTEGER,
    gate_reason TEXT,
    blocked_categories TEXT,       -- JSON array
    payload_size_bytes INTEGER,
    method TEXT,
    created_at INTEGER NOT NULL
)
"""

CREATE_PERFORMANCE_TABLE = """
CREATE TABLE IF NOT EXISTS performance_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT,
    event_type TEXT NOT NULL,
    model_name TEXT,
    backend TEXT,
    latency_ms REAL,
    success INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
)
"""

CREATE_ACTION_EVENTS_TABLE = """
CREATE TABLE IF NOT EXISTS action_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target_id TEXT,
    success INTEGER DEFAULT 1,
    confirmation_required INTEGER DEFAULT 0,
    confirmation_received INTEGER,
    error_message TEXT,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL
)
"""


@asynccontextmanager
async def get_db():
    """Open a database connection as an async context manager.

    Usage:
        async with get_db() as db:
            ...

    A fresh connection is opened for every call and closed on exit,
    which avoids the "threads can only be started once" error that
    occurs when the same aiosqlite Connection object is awaited twice.
    """
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    try:
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")
        yield conn
    finally:
        await conn.close()


async def init_db() -> None:
    """Create all tables if they don't exist."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(CREATE_TASKS_TABLE)
        await db.execute(CREATE_PRIVACY_EVENTS_TABLE)
        await db.execute(CREATE_PERFORMANCE_TABLE)
        await db.execute(CREATE_ACTION_EVENTS_TABLE)
        await db.commit()
    logger.info(f"Database initialised at {Path(DB_PATH).resolve()}")
