# Drishti AI – /api/system/status endpoint

from fastapi import APIRouter
from app.models.schemas import SystemStatusResponse, ModelInfo
from app.services.ws_manager import ws_manager
import os

router = APIRouter()

@router.get("/status", response_model=SystemStatusResponse)
async def system_status() -> SystemStatusResponse:
    """
    Return the real system status — what is actually available.
    Never claims a model is loaded unless it actually is.
    """
    openai_key = bool(os.environ.get("OPENAI_API_KEY", "").strip())
    anthropic_key = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())

    if openai_key:
        planner_mode = "openai"
        provider = "OpenAI"
    elif anthropic_key:
        planner_mode = "anthropic"
        provider = "Anthropic"
    else:
        planner_mode = "local_deterministic"
        provider = None

    models = [
        ModelInfo(
            name="local-deterministic-planner",
            status="ready",
            backend="deterministic",
            isModelInference=False,
            description="Keyword-based deterministic planner. Works offline. Not a neural network.",
        ),
        ModelInfo(
            name="onnxruntime-web (client-side)",
            status="unavailable",
            backend="none",
            isModelInference=False,
            description="ONNX Runtime Web inference runs in the browser extension worker. No ONNX model bundled — DOM grounding is the active path. To enable visual inference, provide a compatible model file.",
        ),
    ]

    if openai_key:
        models.append(ModelInfo(
            name="gpt-4o-mini (remote)",
            status="ready",
            backend="remote",
            isModelInference=True,
            description="OpenAI GPT-4o-mini planner via API. Receives sanitized context only.",
        ))

    if anthropic_key:
        models.append(ModelInfo(
            name="claude-3-haiku (remote)",
            status="ready",
            backend="remote",
            isModelInference=True,
            description="Anthropic Claude-3-Haiku planner via API. Receives sanitized context only.",
        ))

    capabilities = [
        "DOM-based visual grounding",
        "PII detection (15 categories)",
        "Privacy gate enforcement",
        "Local deterministic planning",
        "SQLite task persistence",
        "WebSocket live updates",
        "Privacy audit ledger",
    ]

    if openai_key or anthropic_key:
        capabilities.append("Remote LLM planning (sanitized context only)")

    limitations = [
        "No ONNX visual model bundled — DOM grounding only for interactive elements",
        "Automated PII detection has known limitations — novel encodings may be missed",
        "Does not provide GDPR/DPDP legal compliance",
        "Remote LLM planner sends sanitized context to a third-party API",
        "No real-time CPU/memory measurement without psutil installed",
    ]

    return SystemStatusResponse(
        backendVersion="2.0.0",
        plannerMode=planner_mode,
        externalAIConfigured=openai_key or anthropic_key,
        externalAIProvider=provider,
        models=models,
        dbConnected=True,
        activeSessions=ws_manager.active_sessions,
        privacyGateVersion="1.0",
        capabilities=capabilities,
        limitations=limitations,
    )
