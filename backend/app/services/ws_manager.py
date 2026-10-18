# Drishti AI – WebSocket connection manager
# Allows the backend to push real-time events to connected clients.

from __future__ import annotations
from typing import Dict
from fastapi import WebSocket
import logging
import json

logger = logging.getLogger("drishti.ws")


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: Dict[str, WebSocket] = {}

    async def connect(self, session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[session_id] = websocket
        logger.info(f"WebSocket connected: session={session_id}")

    def disconnect(self, session_id: str) -> None:
        self._connections.pop(session_id, None)
        logger.info(f"WebSocket disconnected: session={session_id}")

    async def broadcast(self, event_type: str, payload: dict) -> None:
        """Send an event to all connected clients."""
        message = json.dumps({"type": event_type, "payload": payload})
        dead: list[str] = []
        for session_id, ws in self._connections.items():
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(session_id)
        for s in dead:
            self._connections.pop(s, None)

    async def send_to_session(self, session_id: str, event_type: str, payload: dict) -> None:
        """Send an event to a specific session."""
        ws = self._connections.get(session_id)
        if ws:
            try:
                await ws.send_text(json.dumps({"type": event_type, "payload": payload}))
            except Exception:
                self._connections.pop(session_id, None)

    @property
    def active_sessions(self) -> int:
        return len(self._connections)


ws_manager = ConnectionManager()
