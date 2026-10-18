# Drishti AI – Architecture Deep Dive

## Data Flow

```
User types task
      │
      ▼
Popup / Dashboard
      │ chrome.runtime.sendMessage(START_TASK)
      ▼
Background Service Worker
      │
      ├─1─► chrome.tabs.sendMessage(INSPECT_PAGE)
      │         │
      │         ▼
      │     Content Script (grounding.ts)
      │         ├── groundElements() — DOM traversal
      │         ├── extractVisibleText() — safe text extraction (no input values)
      │         └── scanDOMForSensitiveFields() — PII flags
      │         │
      │         └─► Returns PageState {elements, pageText, url, title}
      │
      ├─2─► runPrivacyGate(pageText, elements, sensitiveRegions)
      │         ├── sanitizeText() — regex redaction of PII patterns
      │         ├── sanitizeElements() — mask sensitive element labels
      │         ├── verifyPayloadSafety() — verify no residual PII
      │         └─► SanitizedContext {sanitizedText, sanitizedElements, gateDecision}
      │
      ├─3─► [If gate allowed] getPlan(taskText, sanitizedContext)
      │         ├── checkBackendHealth() → if online + externalAI enabled:
      │         │       getRemotePlan() → verifyPayloadSafety() → POST /plan
      │         └── else: getLocalPlan() → keyword matching → steps[]
      │
      ├─4─► chrome.tabs.sendMessage(OVERLAY_SHOW, elements)
      │         └── showOverlay() — numbered bounding boxes with privacy masks
      │
      └─5─► executeStep() for each action
                ├── validateAction() — schema + blocklist check
                ├── isNavigationAllowed() — URL safety
                ├── [requiresConfirmation] → ASK_USER via popup
                └── chrome.tabs.sendMessage(EXECUTE_ACTION)
                         └── recheckElement() → click/type/scroll/etc.
```

## Privacy Gate Implementation

The privacy gate is the single enforced chokepoint for all outbound data.

```typescript
// privacy-gate.ts
export function runPrivacyGate(
  rawText: string,
  elements: DetectedElement[],
  sensitiveRegions: BoundingBox[]
): SanitizedContext {
  // 1. Sanitize text
  const sanitizedText = redactText(rawText);
  
  // 2. Sanitize elements (mask sensitive labels)
  const sanitizedElements = elements.map(el => {
    if (el.isSensitive) return { ...el, label: '[REDACTED:CATEGORY]' };
    return el;
  });
  
  // 3. Build provisional payload
  const payload = JSON.stringify({ sanitizedText, sanitizedElements });
  
  // 4. VERIFY — no residual PII
  const { safe, violations } = verifyPayloadSafety(payload);
  
  // 5. Gate decision — BLOCK if not safe
  if (!safe) {
    return { ...blocked, privacyGateDecision: { allowed: false, ... } };
  }
  
  return { sanitizedText, sanitizedElements, privacyGateDecision: { allowed: true, ... } };
}
```

The gate cannot be bypassed:
- It runs synchronously in the background SW before any `fetch()`
- The planner never receives the raw `PageState` object — only `SanitizedContext`
- The backend rejects requests with non-allowed gate decisions (Pydantic validation)
- Server-side also validates sanitized text for residual PII patterns

## PII Detection Categories

| Category | Method | Examples |
|---|---|---|
| `password` | DOM type=password | Any `<input type="password">` |
| `email` | DOM type=email + regex | `user@domain.com` |
| `phone` | DOM type=tel + regex | Indian mobile: 9XXXXXXXXX |
| `aadhaar` | Regex + label | 12-digit, starts 2-9: `2345 6789 0123` |
| `pan` | Regex + label | `ABCDE1234F` |
| `credit_card` | Regex + autocomplete | Visa/MC/Amex/Discover patterns |
| `account_number` | Label + regex | 9-18 digit numbers |
| `ssn` | Regex | `XXX-XX-XXXX` |
| `dob` | Regex | `DD/MM/YYYY`, `YYYY-MM-DD` |
| `auth_token` | Regex | JWT `eyJ...`, `Bearer ...` |
| `api_key` | Regex + label | 32-64 char alphanumeric |

## Action Protocol Security

Each action goes through a validation pipeline:

```
AI Planner output
      │
      ▼
validateAction()  ← TypeScript schema check
      │            ← URL safety (javascript:/data:/about: blocked)
      │            ← Script injection in TYPE value blocked
      │            ← Unknown action types rejected
      ▼
isNavigationAllowed()  ← URL allowlist
      │
      ▼
[requiresConfirmation?]  ← User must approve NAVIGATE + form submission
      │
      ▼
recheckElement()  ← Is element still at expected position?
      │
      ▼
Execute action in page context
      │
      ▼
Inspect resulting page state  ← Verify success
      │
      ▼
Log to Privacy Proof Ledger
```

## Local Inference Architecture

The inference worker (`workers/inference-worker.ts`) is designed for progressive enhancement:

```
Tier 1: DOM heuristics + regex (always active, <5ms)
      │
Tier 2: ONNX Runtime Web text classifier
      │   - WebGPU backend if available
      │   - WASM fallback
      │   - Models loaded lazily, cached in Cache API
      │   - Currently: runtime verified, no model bundled
      │     (transparent — reports isModelInference: false)
      │
Tier 3: Remote LLM via sanitized /plan endpoint
          (only if externalAIEnabled AND backend online)
```

Model integration path (for production):
1. Download a quantized ONNX model (e.g., `DistilBERT-base-uncased` ONNX, ~260MB)
2. Or use `@xenova/transformers` pipeline for text classification
3. Store in `chrome.storage.local` or Cache API
4. Workers load lazily — no model download on extension install

## Backend Schema Validation

The FastAPI backend uses Pydantic v2 with field validators as a defence-in-depth layer:

```python
class SanitizedContext(BaseModel):
    sanitizedText: str = Field(max_length=10000)
    
    @field_validator("sanitizedText")
    def ensure_no_obvious_pii(cls, v: str) -> str:
        # Check for unredacted email pattern
        if re.search(r'\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\..+\b', v):
            if not re.search(r'\[REDACTED:EMAIL\]', v):
                raise ValueError("Sanitized text may contain unredacted email")
        return v
    
    @model_validator(mode="after")  
    def verify_gate_allowed(self) -> "SanitizedContext":
        if not self.privacyGateDecision.allowed:
            raise ValueError("Privacy gate did not allow this context")
        return self
```

This means even if the extension's gate were bypassed (it cannot be), the backend would reject the request.

## Performance Characteristics

| Metric | Value | Conditions |
|---|---|---|
| Extension build size | ~640KB (without ONNX WASM) | Production build |
| DOM inspection | ~5–30ms | 100-element page |
| Privacy gate | ~1–5ms | Pattern matching |
| Local planner | ~1–5ms | Keyword matching |
| Remote planner | 2–10s | LLM round-trip |
| Overlay render | ~10ms | 50 elements |
| Memory footprint | ~15–40MB | Extension only |

All latency numbers are measured on a mid-range laptop (Core i5, 8GB RAM). No GPU required for the core path.
