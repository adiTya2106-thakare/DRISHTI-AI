# Drishti AI – Pydantic schemas for all API contracts.
# These enforce strict validation on every request and response.

from __future__ import annotations
from typing import Literal, Optional, Union, List, Dict, Any
from pydantic import BaseModel, Field, field_validator, model_validator
import re

# ─── Action Types ─────────────────────────────────────────────────────────────

ActionType = Literal[
    "INSPECT", "CLICK", "TYPE", "SELECT", "SCROLL",
    "NAVIGATE", "WAIT", "ASK_USER", "DONE"
]

VALID_ACTION_TYPES = {
    "INSPECT", "CLICK", "TYPE", "SELECT", "SCROLL",
    "NAVIGATE", "WAIT", "ASK_USER", "DONE"
}

# ─── Agent Action ─────────────────────────────────────────────────────────────

class AgentAction(BaseModel):
    type: ActionType
    elementId: Optional[str] = Field(None, max_length=200)
    selector: Optional[str] = Field(None, max_length=500)
    value: Optional[str] = Field(None, max_length=2000)
    url: Optional[str] = Field(None, max_length=2000)
    direction: Optional[Literal["up", "down", "left", "right"]] = None
    pixels: Optional[int] = Field(None, ge=0, le=10000)
    message: Optional[str] = Field(None, max_length=1000)
    reason: Optional[str] = Field(None, max_length=500)
    requiresConfirmation: Optional[bool] = None
    confidence: Optional[float] = Field(None, ge=0.0, le=1.0)

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        lower = v.strip().lower()
        if lower.startswith("javascript:"):
            raise ValueError("javascript: URLs are not permitted")
        if lower.startswith("data:"):
            raise ValueError("data: URLs are not permitted")
        if lower.startswith("about:"):
            raise ValueError("about: URLs are not permitted")
        return v

    @field_validator("value")
    @classmethod
    def validate_value(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if re.search(r"<script", v, re.IGNORECASE):
            raise ValueError("Script content in value is not permitted")
        return v

    @field_validator("selector")
    @classmethod
    def validate_selector(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Block event handler injection via selector
        if re.search(r"<|>|javascript:|onerror|onload", v, re.IGNORECASE):
            raise ValueError("Invalid selector")
        return v

# ─── Bounding Box ─────────────────────────────────────────────────────────────

class BoundingBox(BaseModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(ge=0)
    height: float = Field(ge=0)

# ─── PII Detection ────────────────────────────────────────────────────────────

SensitiveCategory = Literal[
    "password", "email", "phone", "aadhaar", "pan", "credit_card",
    "account_number", "ssn", "name", "address", "dob",
    "ip_address", "api_key", "auth_token", "generic_pii"
]

class PIIDetection(BaseModel):
    category: SensitiveCategory
    confidence: float = Field(ge=0.0, le=1.0)
    method: Literal["dom_type", "label_match", "pattern_match", "visual_ocr", "heuristic"]
    location: Literal["text", "dom", "screenshot", "payload"]
    masked: bool
    elementId: Optional[str] = None
    bbox: Optional[BoundingBox] = None

# ─── Privacy Gate ─────────────────────────────────────────────────────────────

class PrivacyGateDecision(BaseModel):
    allowed: bool
    reason: str = Field(max_length=500)
    detectionsCount: int = Field(ge=0)
    blockedCategories: List[SensitiveCategory] = Field(default_factory=list)
    sanitizedPayloadSize: int = Field(ge=0)
    timestamp: int
    gateVersion: Literal["1.0"]

# ─── Sanitized Element ────────────────────────────────────────────────────────

class SanitizedElement(BaseModel):
    id: str = Field(max_length=200)
    type: str = Field(max_length=50)
    label: str = Field(max_length=200)
    isInteractive: bool
    isSensitiveRedacted: bool
    bbox: BoundingBox

# ─── Sanitized Context ────────────────────────────────────────────────────────

class SanitizedContext(BaseModel):
    sanitizedText: str = Field(max_length=10000)
    sanitizedElements: List[SanitizedElement] = Field(max_length=500)
    redactedRegions: List[BoundingBox] = Field(default_factory=list)
    privacyGateDecision: PrivacyGateDecision
    detections: List[PIIDetection] = Field(default_factory=list)

    @field_validator("sanitizedText")
    @classmethod
    def ensure_no_obvious_pii(cls, v: str) -> str:
        """
        Server-side residual PII check — defence in depth.
        The extension's privacy gate is the primary check;
        this is an additional verification layer.
        """
        # Check for unredacted email-like patterns
        if re.search(r'\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b', v):
            # Allow if already wrapped in [REDACTED:EMAIL]
            if not re.search(r'\[REDACTED:EMAIL\]', v):
                raise ValueError("Sanitized text may contain unredacted email address")
        # Check for password field patterns
        if re.search(r'"password"\s*:\s*"[^"]{3,}"', v, re.IGNORECASE):
            raise ValueError("Sanitized text may contain password field")
        return v

    @model_validator(mode="after")
    def verify_gate_allowed(self) -> "SanitizedContext":
        if not self.privacyGateDecision.allowed:
            raise ValueError(
                f"Privacy gate did not allow this context: {self.privacyGateDecision.reason}"
            )
        return self

# ─── Plan Request ─────────────────────────────────────────────────────────────

class PlanRequest(BaseModel):
    taskText: str = Field(min_length=1, max_length=1000)
    sanitizedContext: SanitizedContext
    pageUrl: str = Field(max_length=2000)
    sessionId: str = Field(max_length=100)

    @field_validator("pageUrl")
    @classmethod
    def sanitize_page_url(cls, v: str) -> str:
        # Strip sensitive query parameters server-side
        from urllib.parse import urlparse, urlencode, parse_qs, urlunparse
        try:
            parsed = urlparse(v)
            params = parse_qs(parsed.query)
            sensitive = {"token", "auth", "key", "secret", "password", "session",
                        "access_token", "refresh_token", "api_key"}
            filtered = {k: vv for k, vv in params.items() if k.lower() not in sensitive}
            clean_query = urlencode(filtered, doseq=True)
            return urlunparse(parsed._replace(query=clean_query))
        except Exception:
            # If parsing fails, return path only
            return v.split("?")[0]

# ─── Plan Response ────────────────────────────────────────────────────────────

class PlanResponse(BaseModel):
    planId: str
    steps: List[AgentAction] = Field(max_length=50)
    plannerUsed: str = Field(max_length=100)
    warnings: List[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_steps(self) -> "PlanResponse":
        for step in self.steps:
            if step.type not in VALID_ACTION_TYPES:
                raise ValueError(f"Invalid action type in plan: {step.type}")
        return self

# ─── Health ───────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    plannerAvailable: bool
    externalAIConfigured: bool
    dbConnected: bool = True
    activeSessions: int = 0
    uptime_seconds: float = 0.0

# ─── System Status ────────────────────────────────────────────────────────────

class ModelInfo(BaseModel):
    name: str
    status: Literal["unloaded", "loading", "ready", "error", "unavailable"]
    backend: Literal["webgpu", "wasm", "remote", "deterministic", "none"]
    isModelInference: bool
    description: str

class SystemStatusResponse(BaseModel):
    backendVersion: str
    plannerMode: Literal["local_deterministic", "openai", "anthropic", "unavailable"]
    externalAIConfigured: bool
    externalAIProvider: Optional[str]
    models: List[ModelInfo]
    dbConnected: bool
    activeSessions: int
    privacyGateVersion: Literal["1.0"]
    capabilities: List[str]
    limitations: List[str]

# ─── Task History ─────────────────────────────────────────────────────────────

class TaskHistoryItem(BaseModel):
    id: str
    sessionId: str
    taskText: str                     # sanitized — no raw PII
    status: Literal["started", "completed", "failed", "cancelled"]
    plannerUsed: Optional[str]
    stepsCount: int
    privacyGateAllowed: bool
    detectionsCount: int
    durationMs: Optional[int]
    createdAt: int
    completedAt: Optional[int]

class TaskHistoryResponse(BaseModel):
    tasks: List[TaskHistoryItem]
    total: int
    page: int
    pageSize: int

class TaskEventRequest(BaseModel):
    """Record a task execution event without storing raw sensitive data."""
    taskId: str = Field(max_length=100)
    sessionId: str = Field(max_length=100)
    eventType: Literal["started", "completed", "failed", "action_executed", "action_failed"]
    actionType: Optional[str] = Field(None, max_length=50)
    success: bool = True
    confirmationRequired: bool = False
    confirmationReceived: Optional[bool] = None
    latencyMs: Optional[int] = Field(None, ge=0, le=300000)
    # error message is allowed but must not contain PII
    errorMessage: Optional[str] = Field(None, max_length=500)

    @field_validator("errorMessage")
    @classmethod
    def strip_pii_from_error(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Redact any email-like patterns from error messages
        v = re.sub(r'\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b', '[REDACTED:EMAIL]', v)
        return v[:500]

# ─── Privacy Events ───────────────────────────────────────────────────────────

class PrivacyEventItem(BaseModel):
    id: str
    sessionId: str
    taskId: Optional[str]
    eventType: str
    # No raw values — only metadata
    categories: List[str]
    count: int
    maskedCount: int
    gateAllowed: Optional[bool]
    gateReason: Optional[str]
    blockedCategories: List[str]
    payloadSizeBytes: Optional[int]
    method: Optional[str]
    createdAt: int

class PrivacyEventsResponse(BaseModel):
    events: List[PrivacyEventItem]
    total: int
    totalDetections: int
    totalMasked: int
    totalBlocked: int

class PrivacyEventRequest(BaseModel):
    """Record a privacy gate or detection event."""
    sessionId: str = Field(max_length=100)
    taskId: Optional[str] = Field(None, max_length=100)
    eventType: Literal["pii_detected", "privacy_gate", "network_blocked", "network_allowed"]
    categories: List[SensitiveCategory] = Field(default_factory=list, max_length=30)
    count: int = Field(ge=0, le=10000)
    maskedCount: int = Field(ge=0, le=10000)
    gateAllowed: Optional[bool] = None
    gateReason: Optional[str] = Field(None, max_length=500)
    blockedCategories: List[SensitiveCategory] = Field(default_factory=list)
    payloadSizeBytes: Optional[int] = Field(None, ge=0)
    method: Optional[str] = Field(None, max_length=50)

# ─── Performance ──────────────────────────────────────────────────────────────

class LatencyStats(BaseModel):
    count: int
    medianMs: Optional[float]        # None if no data
    p95Ms: Optional[float]
    minMs: Optional[float]
    maxMs: Optional[float]
    avgMs: Optional[float]

class PerformanceResponse(BaseModel):
    taskLatency: LatencyStats
    inferenceLatency: LatencyStats
    taskSuccessRate: Optional[float]   # None if no completed tasks
    blockedRequestsCount: int
    totalTasksCount: int
    completedTasksCount: int
    failedTasksCount: int
    # CPU/memory: only if psutil available; None otherwise
    cpuPercent: Optional[float]
    memoryMB: Optional[float]
    note: str                         # always explain what is/isn't measured

# ─── Benchmark ────────────────────────────────────────────────────────────────

class BenchmarkRunRequest(BaseModel):
    includeSyntheticOnly: bool = True  # must be true — no real PII in benchmarks
    suiteVersion: str = Field(default="v1", max_length=20)

class PIIBenchmarkResult(BaseModel):
    truePositives: int
    falsePositives: int
    falseNegatives: int
    precision: float
    recall: float
    f1: float

class BenchmarkRunResponse(BaseModel):
    suiteId: str
    suiteVersion: str
    isSimulated: bool                 # always True — synthetic data
    ranAt: int
    durationMs: int
    piiDetection: PIIBenchmarkResult
    redactionPrecision: float
    falsePositiveRate: float
    blockedUnsafeRequests: int
    latencyMs: int
    testCasesTotal: int
    testCasesPassed: int
    notes: str
    limitations: List[str]

# ─── Error ────────────────────────────────────────────────────────────────────

class ErrorResponse(BaseModel):
    detail: str
    code: str
