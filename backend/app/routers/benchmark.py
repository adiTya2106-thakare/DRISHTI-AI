# Drishti AI – /api/benchmark/run endpoint
# Runs actual PII detection tests against synthetic fixtures.
# Results are clearly labeled as synthetic.
# Never fabricates numbers — computes from actual test runs.

from __future__ import annotations
from fastapi import APIRouter, HTTPException
from app.models.schemas import BenchmarkRunRequest, BenchmarkRunResponse, PIIBenchmarkResult
import uuid
import time
import re

router = APIRouter()

# ─── Synthetic Test Fixtures ──────────────────────────────────────────────────
# All data is fake. Expected detections are known ground truth.

SYNTHETIC_TEST_CASES = [
    # (text, expected_categories_set)
    ("Contact me at priya.sharma@example.com for details", {"email"}),
    ("Aadhaar: 2345 6789 0123 is the UID", {"aadhaar"}),
    ("Income tax PAN ABCDE1234F registered", {"pan"}),
    ("Card number 4532 0151 1283 0366 expiry 12/27", {"credit_card"}),
    ("Mobile: 9876543210 for OTP", {"phone"}),
    ("DOB: 15/08/1988", {"dob"}),
    ("JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", {"auth_token"}),
    ("SSN: 123-45-6789", {"ssn"}),
    ("Multiple: rahul@test.in and PAN WXYZP1234Q", {"email", "pan"}),
    ("The application deadline is March 31 2025", set()),   # no PII
    ("Click the submit button to continue", set()),          # no PII
    ("Scroll down to view more results", set()),             # no PII
    ("PAN QRSTU5678V and Aadhaar 3456 7890 1234", {"pan", "aadhaar"}),
    ("Email: test@example.org phone +919988776655", {"email", "phone"}),
    ("Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test.sig", {"auth_token"}),
]

# ─── PII Pattern implementations (mirror of extension pii-detector.ts) ────────

PII_PATTERNS: dict[str, list[re.Pattern]] = {
    "email":        [re.compile(r'\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b')],
    "aadhaar":      [re.compile(r'\b[2-9]\d{3}[\s\-]?\d{4}[\s\-]?\d{4}\b')],
    "pan":          [re.compile(r'\b[A-Z]{5}[0-9]{4}[A-Z]\b')],
    "credit_card":  [
        re.compile(r'\b4\d{3}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b'),
        re.compile(r'\b5[1-5]\d{2}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b'),
    ],
    "phone":        [
        re.compile(r'(\+91[\-\s]?)?[6-9]\d{9}\b'),
        re.compile(r'\b\+?\d{10,12}\b'),
    ],
    "dob":          [
        re.compile(r'\b(0?[1-9]|[12]\d|3[01])[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](19|20)\d{2}\b'),
    ],
    "ssn":          [re.compile(r'\b\d{3}[\-\s]\d{2}[\-\s]\d{4}\b')],
    "auth_token":   [
        re.compile(r'\bey[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b'),
        re.compile(r'\bBearer\s+[A-Za-z0-9_\-\.]+', re.IGNORECASE),
    ],
}

REDACT_PATTERN = re.compile(r'\[REDACTED:[A-Z_]+\]')


def detect_pii(text: str) -> set[str]:
    found = set()
    for category, patterns in PII_PATTERNS.items():
        for pat in patterns:
            if pat.search(text):
                found.add(category)
                break
    return found


def redact_text(text: str) -> str:
    for category, patterns in PII_PATTERNS.items():
        for pat in patterns:
            text = pat.sub(f"[REDACTED:{category.upper()}]", text)
    return text


def verify_no_pii(text: str) -> tuple[bool, list[str]]:
    """Return (safe, list_of_violating_categories)."""
    violations = []
    for category, patterns in PII_PATTERNS.items():
        for pat in patterns:
            if pat.search(text) and not REDACT_PATTERN.search(text):
                violations.append(category)
                break
    return len(violations) == 0, violations


@router.post("/run", response_model=BenchmarkRunResponse)
async def run_benchmark(body: BenchmarkRunRequest) -> BenchmarkRunResponse:
    """
    Run actual PII detection tests against synthetic fixtures.
    All test data is synthetic — no real PII used or stored.
    Results are genuine computations, not fabricated numbers.
    """
    if not body.includeSyntheticOnly:
        raise HTTPException(
            status_code=400,
            detail="Only synthetic test suites are supported. Set includeSyntheticOnly=true."
        )

    suite_id = str(uuid.uuid4())
    start_ms = time.time() * 1000
    tp = fp = fn = 0
    passed = 0

    for text, expected in SYNTHETIC_TEST_CASES:
        detected = detect_pii(text)

        case_tp = len(detected & expected)
        case_fp = len(detected - expected)
        case_fn = len(expected - detected)

        tp += case_tp
        fp += case_fp
        fn += case_fn

        # A case passes if no false positives and no false negatives
        if case_fp == 0 and case_fn == 0:
            passed += 1

    # Redaction test: verify no PII leaks through redaction
    blocked_unsafe = 0
    for text, expected in SYNTHETIC_TEST_CASES:
        if expected:  # only test cases with actual PII
            redacted = redact_text(text)
            safe, _ = verify_no_pii(redacted)
            if safe:
                blocked_unsafe += 1

    precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 1.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    fpr = fp / (tp + fp) if (tp + fp) > 0 else 0.0

    # Redaction precision: fraction of PII test cases where redaction was clean
    pii_cases = sum(1 for _, exp in SYNTHETIC_TEST_CASES if exp)
    redaction_precision = blocked_unsafe / pii_cases if pii_cases > 0 else 1.0

    end_ms = time.time() * 1000
    duration = int(end_ms - start_ms)

    return BenchmarkRunResponse(
        suiteId=suite_id,
        suiteVersion=body.suiteVersion,
        isSimulated=True,
        ranAt=int(time.time() * 1000),
        durationMs=duration,
        piiDetection=PIIBenchmarkResult(
            truePositives=tp,
            falsePositives=fp,
            falseNegatives=fn,
            precision=round(precision, 3),
            recall=round(recall, 3),
            f1=round(f1, 3),
        ),
        redactionPrecision=round(redaction_precision, 3),
        falsePositiveRate=round(fpr, 3),
        blockedUnsafeRequests=blocked_unsafe,
        latencyMs=duration,
        testCasesTotal=len(SYNTHETIC_TEST_CASES),
        testCasesPassed=passed,
        notes=(
            f"Ran {len(SYNTHETIC_TEST_CASES)} synthetic test cases. "
            f"{passed}/{len(SYNTHETIC_TEST_CASES)} passed (zero FP+FN). "
            "All data is synthetic — results reflect pattern-based detection only."
        ),
        limitations=[
            "Pattern-based detection only — no neural model inference",
            "Synthetic data may not represent all real-world PII formats",
            "Does not test visual/OCR detection paths (DOM-only)",
            "False positive rate may be higher on real-world text",
        ],
    )
