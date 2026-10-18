// Drishti AI – Shared Type Definitions
// All messages, actions, privacy events, and ledger entries are typed here.

// ─── Action Protocol ──────────────────────────────────────────────────────────

export type ActionType =
  | 'INSPECT'
  | 'CLICK'
  | 'TYPE'
  | 'SELECT'
  | 'SCROLL'
  | 'NAVIGATE'
  | 'WAIT'
  | 'ASK_USER'
  | 'DONE';

export interface AgentAction {
  type: ActionType;
  elementId?: string;
  selector?: string;
  value?: string;
  url?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  message?: string;
  reason?: string;
  requiresConfirmation?: boolean;
  confidence?: number;
}

export type ActionResult =
  | { success: true; message: string; newState?: PageState }
  | { success: false; error: string; retryable: boolean };

// ─── Page State ───────────────────────────────────────────────────────────────

export interface DetectedElement {
  id: string;               // stable drishti-assigned ID
  type: 'button' | 'link' | 'input' | 'select' | 'textarea' | 'heading' | 'form' | 'image' | 'text' | 'checkbox' | 'radio' | 'other';
  label: string;
  selector: string;
  bbox: BoundingBox;
  confidence: number;
  source: 'dom' | 'visual' | 'hybrid';
  isSensitive?: boolean;
  sensitiveCategory?: SensitiveCategory;
  isInteractive: boolean;
  tagName: string;
  attributes: Record<string, string>;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageState {
  url: string;
  title: string;
  timestamp: number;
  elements: DetectedElement[];
  pageText: string;       // sanitized text only
  screenshotDataUrl?: string; // always redacted before this field is populated
}

// ─── Privacy Layer ────────────────────────────────────────────────────────────

export type SensitiveCategory =
  | 'password'
  | 'email'
  | 'phone'
  | 'aadhaar'
  | 'pan'
  | 'credit_card'
  | 'account_number'
  | 'ssn'
  | 'name'
  | 'address'
  | 'dob'
  | 'ip_address'
  | 'api_key'
  | 'auth_token'
  | 'generic_pii';

export interface PIIDetection {
  category: SensitiveCategory;
  confidence: number;
  method: 'dom_type' | 'label_match' | 'pattern_match' | 'visual_ocr' | 'heuristic';
  location: 'text' | 'dom' | 'screenshot' | 'payload';
  masked: boolean;
  elementId?: string;
  bbox?: BoundingBox;
}

export interface PrivacyGateDecision {
  allowed: boolean;
  reason: string;
  detectionsCount: number;
  blockedCategories: SensitiveCategory[];
  sanitizedPayloadSize: number;
  timestamp: number;
  gateVersion: '1.0';
}

export interface SanitizedContext {
  sanitizedText: string;
  sanitizedElements: SanitizedElement[];
  redactedRegions: BoundingBox[];
  privacyGateDecision: PrivacyGateDecision;
  detections: PIIDetection[];
}

export interface SanitizedElement {
  id: string;
  type: DetectedElement['type'];
  label: string;           // redacted label if sensitive
  isInteractive: boolean;
  isSensitiveRedacted: boolean;
  bbox: BoundingBox;
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  eventType: 'pii_detected' | 'privacy_gate' | 'action_executed' | 'action_verified' | 'task_start' | 'task_done' | 'model_inference' | 'network_blocked' | 'network_allowed';
  summary: string;
  details: LedgerDetails;
}

export type LedgerDetails =
  | PIILedgerDetails
  | GateLedgerDetails
  | ActionLedgerDetails
  | InferenceLedgerDetails
  | NetworkLedgerDetails
  | TaskLedgerDetails;

export interface PIILedgerDetails {
  kind: 'pii';
  categories: SensitiveCategory[];
  count: number;
  masked: number;
  methods: string[];
}

export interface GateLedgerDetails {
  kind: 'gate';
  allowed: boolean;
  reason: string;
  sanitizedCategories: string[];
  blockedCategories: SensitiveCategory[];
}

export interface ActionLedgerDetails {
  kind: 'action';
  actionType: ActionType;
  targetId?: string;
  success: boolean;
  confirmationRequired: boolean;
  confirmationReceived?: boolean;
  latencyMs?: number;
}

export interface InferenceLedgerDetails {
  kind: 'inference';
  modelName: string;
  backend: 'webgpu' | 'wasm' | 'remote';
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface NetworkLedgerDetails {
  kind: 'network';
  endpoint: string;
  blocked: boolean;
  reason?: string;
  payloadSizeBytes: number;
}

export interface TaskLedgerDetails {
  kind: 'task';
  taskText: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  actionsCount?: number;
  durationMs?: number;
}

// ─── Messages (Extension Internal) ───────────────────────────────────────────

export type ExtensionMessage =
  | { type: 'INSPECT_PAGE' }
  | { type: 'INSPECT_RESULT'; payload: PageState }
  | { type: 'START_TASK'; payload: { taskText: string } }
  | { type: 'TASK_PLAN'; payload: TaskPlan }
  | { type: 'EXECUTE_ACTION'; payload: AgentAction }
  | { type: 'ACTION_RESULT'; payload: ActionResult }
  | { type: 'CONFIRM_ACTION'; payload: { actionId: string; confirmed: boolean } }
  | { type: 'PRIVACY_GATE_RESULT'; payload: PrivacyGateDecision }
  | { type: 'LEDGER_ENTRY'; payload: LedgerEntry }
  | { type: 'OVERLAY_SHOW'; payload: { elements: DetectedElement[] } }
  | { type: 'OVERLAY_HIDE' }
  | { type: 'STATUS_UPDATE'; payload: SystemStatus }
  | { type: 'ERROR'; payload: { message: string; code: string } };

export interface TaskPlan {
  id: string;
  taskText: string;
  steps: AgentAction[];
  plannerUsed: 'local_deterministic' | 'llm' | 'vlm';
  sanitizedContextSent: boolean;
  timestamp: number;
}

export interface SystemStatus {
  modelStatus: 'unloaded' | 'loading' | 'ready' | 'error';
  modelName: string;
  backend: 'webgpu' | 'wasm' | 'none';
  backendOnline: boolean;
  externalAIEnabled: boolean;
  lastInferenceMs?: number;
  cpuPercent?: number;
  memoryMB?: number;
}

// ─── Backend API Contracts ────────────────────────────────────────────────────

export interface PlanRequest {
  taskText: string;
  sanitizedContext: SanitizedContext;
  pageUrl: string;         // stripped of query params if sensitive
  sessionId: string;
}

export interface PlanResponse {
  planId: string;
  steps: AgentAction[];
  plannerUsed: string;
  warnings: string[];
}

// ─── Benchmark / Attack Lab ───────────────────────────────────────────────────

export interface BenchmarkResult {
  testSuiteId: string;
  timestamp: number;
  isSimulated: boolean;
  piiDetection: {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    f1: number;
  };
  redaction: {
    precision: number;
    missedRegions: number;
  };
  falsePositiveRate: number;
  elementAccuracy: number;
  taskSuccessRate: number;
  latency: {
    medianMs: number;
    p95Ms: number;
    inferenceMs: number;
  };
  blockedRequests: number;
  cpuPercent?: number;
  memoryMB?: number;
  notes: string;
}
