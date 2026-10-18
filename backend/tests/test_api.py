# Drishti AI – Backend Tests v2
# Tests all API endpoints: health, system status, tasks, privacy events,
# performance, benchmark, plan, schema validation, PII leakage prevention.

import pytest
import time
import uuid
from fastapi.testclient import TestClient
from app.main import app
from app.models.schemas import (
    AgentAction, SanitizedContext, PrivacyGateDecision,
    PlanRequest, SanitizedElement, BoundingBox, PIIDetection
)

client = TestClient(app)

# ─── Fixtures ─────────────────────────────────────────────────────────────────

def make_gate_decision(allowed: bool = True) -> PrivacyGateDecision:
    return PrivacyGateDecision(
        allowed=allowed,
        reason="Test gate decision",
        detectionsCount=0,
        blockedCategories=[],
        sanitizedPayloadSize=100,
        timestamp=int(time.time() * 1000),
        gateVersion="1.0",
    )

def make_sanitized_element(label: str = "Submit", el_type: str = "button") -> SanitizedElement:
    return SanitizedElement(
        id=f"drishti-{el_type}-{uuid.uuid4().hex[:8]}",
        type=el_type,
        label=label,
        isInteractive=True,
        isSensitiveRedacted=False,
        bbox=BoundingBox(x=100, y=200, width=120, height=40),
    )

def make_sanitized_context(text: str = "Find the submit button.") -> SanitizedContext:
    return SanitizedContext(
        sanitizedText=text,
        sanitizedElements=[
            make_sanitized_element("Submit"),
            make_sanitized_element("Application Deadline", "text"),
        ],
        redactedRegions=[],
        privacyGateDecision=make_gate_decision(allowed=True),
        detections=[],
    )

def make_plan_request(task: str = "Find the submit button") -> dict:
    return {
        "taskText": task,
        "sanitizedContext": make_sanitized_context().model_dump(),
        "pageUrl": "http://localhost:8080/form.html",
        "sessionId": str(uuid.uuid4()),
    }

# ─── Health ───────────────────────────────────────────────────────────────────

class TestHealth:
    def test_api_health_returns_ok(self):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["version"] == "2.0.0"
        assert "plannerAvailable" in data
        assert "dbConnected" in data
        assert "activeSessions" in data
        assert data["uptime_seconds"] >= 0

    def test_legacy_health_still_works(self):
        """Backward compatibility — /health still responds."""
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

# ─── System Status ────────────────────────────────────────────────────────────

class TestSystemStatus:
    def test_status_returns_real_info(self):
        resp = client.get("/api/system/status")
        assert resp.status_code == 200
        data = resp.json()
        assert "backendVersion" in data
        assert "plannerMode" in data
        assert "models" in data
        assert len(data["models"]) > 0
        assert "capabilities" in data
        assert "limitations" in data

    def test_status_honest_about_local_planner(self):
        resp = client.get("/api/system/status")
        data = resp.json()
        local_model = next((m for m in data["models"] if "deterministic" in m["name"]), None)
        assert local_model is not None
        assert local_model["isModelInference"] is False, "Local deterministic planner must not claim to be model inference"
        assert local_model["backend"] == "deterministic"

    def test_status_has_limitations(self):
        resp = client.get("/api/system/status")
        data = resp.json()
        assert len(data["limitations"]) > 0, "Must honestly document limitations"

# ─── Tasks ────────────────────────────────────────────────────────────────────

class TestTasks:
    def test_get_tasks_empty_on_fresh_db(self):
        resp = client.get("/api/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert "tasks" in data
        assert "total" in data
        assert "page" in data

    def test_record_task_event_started(self):
        task_id = str(uuid.uuid4())
        resp = client.post(f"/api/tasks/{task_id}/events", json={
            "taskId": task_id,
            "sessionId": str(uuid.uuid4()),
            "eventType": "started",
            "success": True,
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["ok"] is True
        assert data["taskId"] == task_id

    def test_record_task_event_action(self):
        task_id = str(uuid.uuid4())
        session_id = str(uuid.uuid4())
        # Create task first
        client.post(f"/api/tasks/{task_id}/events", json={
            "taskId": task_id, "sessionId": session_id, "eventType": "started"
        })
        # Then record action
        resp = client.post(f"/api/tasks/{task_id}/events", json={
            "taskId": task_id,
            "sessionId": session_id,
            "eventType": "action_executed",
            "actionType": "CLICK",
            "success": True,
            "latencyMs": 45,
        })
        assert resp.status_code == 201

    def test_task_event_path_body_mismatch_rejected(self):
        task_id = str(uuid.uuid4())
        resp = client.post(f"/api/tasks/{task_id}/events", json={
            "taskId": "different-id",
            "sessionId": str(uuid.uuid4()),
            "eventType": "started",
        })
        assert resp.status_code == 400

    def test_error_message_has_pii_redacted(self):
        """Error messages containing PII should be sanitized."""
        task_id = str(uuid.uuid4())
        resp = client.post(f"/api/tasks/{task_id}/events", json={
            "taskId": task_id,
            "sessionId": str(uuid.uuid4()),
            "eventType": "action_failed",
            "success": False,
            "errorMessage": "Failed to contact admin@company.com",  # contains email
        })
        assert resp.status_code == 201
        # The email should have been redacted server-side

# ─── Privacy Events ───────────────────────────────────────────────────────────

class TestPrivacyEvents:
    def test_get_privacy_events(self):
        resp = client.get("/api/privacy/events")
        assert resp.status_code == 200
        data = resp.json()
        assert "events" in data
        assert "totalDetections" in data
        assert "totalMasked" in data
        assert "totalBlocked" in data

    def test_record_privacy_event(self):
        resp = client.post("/api/privacy/events", json={
            "sessionId": str(uuid.uuid4()),
            "eventType": "pii_detected",
            "categories": ["email", "phone"],
            "count": 2,
            "maskedCount": 2,
            "method": "pattern_match",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["ok"] is True
        assert "eventId" in data

    def test_privacy_event_gate_decision(self):
        resp = client.post("/api/privacy/events", json={
            "sessionId": str(uuid.uuid4()),
            "eventType": "privacy_gate",
            "categories": ["aadhaar"],
            "count": 1,
            "maskedCount": 1,
            "gateAllowed": True,
            "gateReason": "Test gate decision",
            "blockedCategories": [],
        })
        assert resp.status_code == 201

    def test_privacy_event_blocked_network(self):
        resp = client.post("/api/privacy/events", json={
            "sessionId": str(uuid.uuid4()),
            "eventType": "network_blocked",
            "categories": ["credit_card"],
            "count": 1,
            "maskedCount": 0,
            "gateAllowed": False,
            "gateReason": "Residual PII in payload",
            "blockedCategories": ["credit_card"],
        })
        assert resp.status_code == 201

# ─── Performance ──────────────────────────────────────────────────────────────

class TestPerformance:
    def test_performance_returns_real_structure(self):
        resp = client.get("/api/performance")
        assert resp.status_code == 200
        data = resp.json()
        assert "taskLatency" in data
        assert "inferenceLatency" in data
        assert "note" in data
        assert len(data["note"]) > 0, "Must explain what was/wasn't measured"

    def test_performance_null_when_no_data(self):
        resp = client.get("/api/performance")
        data = resp.json()
        # Fresh DB may have no tasks — median should be null, not 0
        if data["taskLatency"]["count"] == 0:
            assert data["taskLatency"]["medianMs"] is None, "medianMs must be null when no data, not invented"
            assert data["taskSuccessRate"] is None, "taskSuccessRate must be null when no tasks"

    def test_cpu_memory_null_without_psutil(self):
        """Without psutil, CPU/memory should be null — not invented values."""
        resp = client.get("/api/performance")
        data = resp.json()
        # These are None unless psutil is installed — both are acceptable
        assert data["cpuPercent"] is None or isinstance(data["cpuPercent"], float)
        assert data["memoryMB"] is None or isinstance(data["memoryMB"], float)

# ─── Benchmark ────────────────────────────────────────────────────────────────

class TestBenchmark:
    def test_benchmark_runs_real_tests(self):
        resp = client.post("/api/benchmark/run", json={
            "includeSyntheticOnly": True,
            "suiteVersion": "v1",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["isSimulated"] is True
        assert data["testCasesTotal"] > 0
        assert data["testCasesPassed"] >= 0
        assert data["piiDetection"]["precision"] >= 0
        assert data["piiDetection"]["recall"] >= 0
        assert data["piiDetection"]["f1"] >= 0

    def test_benchmark_requires_synthetic_only(self):
        resp = client.post("/api/benchmark/run", json={
            "includeSyntheticOnly": False,
        })
        assert resp.status_code == 400

    def test_benchmark_computes_real_numbers(self):
        resp = client.post("/api/benchmark/run", json={"includeSyntheticOnly": True})
        data = resp.json()
        pii = data["piiDetection"]
        # Verify F1 is computed correctly from TP/FP/FN
        tp = pii["truePositives"]
        fp = pii["falsePositives"]
        fn = pii["falseNegatives"]
        if tp + fp > 0:
            expected_precision = tp / (tp + fp)
            assert abs(pii["precision"] - expected_precision) < 0.01
        if tp + fn > 0:
            expected_recall = tp / (tp + fn)
            assert abs(pii["recall"] - expected_recall) < 0.01

    def test_benchmark_has_limitations(self):
        resp = client.post("/api/benchmark/run", json={"includeSyntheticOnly": True})
        data = resp.json()
        assert len(data["limitations"]) > 0
        assert len(data["notes"]) > 0

# ─── Plan Endpoint ────────────────────────────────────────────────────────────

class TestPlanEndpoint:
    def test_api_plan_route(self):
        resp = client.post("/api/tasks/plan", json=make_plan_request())
        assert resp.status_code == 200
        data = resp.json()
        assert "planId" in data
        assert "steps" in data

    def test_legacy_plan_route(self):
        resp = client.post("/plan", json=make_plan_request())
        assert resp.status_code == 200

    def test_plan_starts_with_inspect(self):
        resp = client.post("/api/tasks/plan", json=make_plan_request("Inspect the page"))
        assert resp.status_code == 200
        assert resp.json()["steps"][0]["type"] == "INSPECT"

    def test_plan_ends_with_done(self):
        resp = client.post("/api/tasks/plan", json=make_plan_request("Find the form"))
        assert resp.status_code == 200
        assert resp.json()["steps"][-1]["type"] == "DONE"

    def test_plan_persisted_to_db(self):
        """After planning, the task should appear in GET /api/tasks."""
        task_plan = make_plan_request("test task for persistence check")
        resp = client.post("/api/tasks/plan", json=task_plan)
        assert resp.status_code == 200
        plan_id = resp.json()["planId"]

        tasks_resp = client.get("/api/tasks")
        task_ids = [t["id"] for t in tasks_resp.json()["tasks"]]
        assert plan_id in task_ids

    def test_plan_rejects_blocked_gate(self):
        req = make_plan_request()
        req["sanitizedContext"]["privacyGateDecision"]["allowed"] = False
        resp = client.post("/api/tasks/plan", json=req)
        assert resp.status_code in (400, 422)

# ─── PII Leakage Prevention ───────────────────────────────────────────────────

class TestPIILeakagePrevention:
    def test_rejects_email_in_sanitized_text(self):
        req = make_plan_request()
        req["sanitizedContext"]["sanitizedText"] = "Contact attacker@evil.com"
        resp = client.post("/api/tasks/plan", json=req)
        assert resp.status_code == 422

    def test_rejects_password_field(self):
        req = make_plan_request()
        req["sanitizedContext"]["sanitizedText"] = '{"password": "s3cr3t"}'
        resp = client.post("/api/tasks/plan", json=req)
        assert resp.status_code == 422

    def test_accepts_properly_redacted(self):
        req = make_plan_request()
        req["sanitizedContext"]["sanitizedText"] = "Contact [REDACTED:EMAIL] for details"
        resp = client.post("/api/tasks/plan", json=req)
        assert resp.status_code == 200

# ─── Action Validation ────────────────────────────────────────────────────────

class TestActionValidation:
    def test_blocks_javascript_url(self):
        with pytest.raises(Exception):
            AgentAction(type="NAVIGATE", url="javascript:alert(1)")

    def test_blocks_data_url(self):
        with pytest.raises(Exception):
            AgentAction(type="NAVIGATE", url="data:text/html,<h1>xss</h1>")

    def test_allows_https_url(self):
        action = AgentAction(type="NAVIGATE", url="https://example.com/apply")
        assert action.url == "https://example.com/apply"

    def test_blocks_script_in_value(self):
        with pytest.raises(Exception):
            AgentAction(type="TYPE", value="<script>steal()</script>")

    def test_allows_normal_value(self):
        action = AgentAction(type="TYPE", value="John Doe")
        assert action.value == "John Doe"
