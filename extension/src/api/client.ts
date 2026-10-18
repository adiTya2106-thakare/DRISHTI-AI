// Drishti AI – Central API Client
// All backend communication goes through this module.
// Configurable base URL. Handles errors, timeouts, and connection status.
// Never transmits raw PII — callers must pass sanitized context only.

export const BACKEND_BASE_URL = 
  (typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).__DRISHTI_BACKEND_URL as string) ||
  'http://localhost:8000';

export type ApiResult<T> =
  | { ok: true; data: T; latencyMs: number }
  | { ok: false; error: string; status?: number; latencyMs: number };

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  const start = Date.now();
  try {
    const resp = await fetch(`${BACKEND_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(15000),
    });

    const latencyMs = Date.now() - start;

    if (!resp.ok) {
      let error = `HTTP ${resp.status}`;
      try {
        const errData = await resp.json() as { detail?: string };
        if (errData.detail) error = errData.detail;
      } catch { /* ignore */ }
      return { ok: false, error, status: resp.status, latencyMs };
    }

    const data = await resp.json() as T;
    return { ok: true, data, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { ok: false, error: 'Request timed out', latencyMs };
    }
    if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
      return { ok: false, error: 'Backend unavailable', latencyMs };
    }
    return { ok: false, error: String(err), latencyMs };
  }
}

// ─── API Types (mirrors backend schemas) ─────────────────────────────────────

export interface BackendHealth {
  status: 'ok';
  version: string;
  plannerAvailable: boolean;
  externalAIConfigured: boolean;
  dbConnected: boolean;
  activeSessions: number;
  uptime_seconds: number;
}

export interface ModelInfo {
  name: string;
  status: 'unloaded' | 'loading' | 'ready' | 'error' | 'unavailable';
  backend: 'webgpu' | 'wasm' | 'remote' | 'deterministic' | 'none';
  isModelInference: boolean;
  description: string;
}

export interface BackendSystemStatus {
  backendVersion: string;
  plannerMode: 'local_deterministic' | 'openai' | 'anthropic' | 'unavailable';
  externalAIConfigured: boolean;
  externalAIProvider: string | null;
  models: ModelInfo[];
  dbConnected: boolean;
  activeSessions: number;
  privacyGateVersion: '1.0';
  capabilities: string[];
  limitations: string[];
}

export interface TaskHistoryItem {
  id: string;
  sessionId: string;
  taskText: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  plannerUsed: string | null;
  stepsCount: number;
  privacyGateAllowed: boolean;
  detectionsCount: number;
  durationMs: number | null;
  createdAt: number;
  completedAt: number | null;
}

export interface TaskHistoryResponse {
  tasks: TaskHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PrivacyEventItem {
  id: string;
  sessionId: string;
  taskId: string | null;
  eventType: string;
  categories: string[];
  count: number;
  maskedCount: number;
  gateAllowed: boolean | null;
  gateReason: string | null;
  blockedCategories: string[];
  payloadSizeBytes: number | null;
  method: string | null;
  createdAt: number;
}

export interface PrivacyEventsResponse {
  events: PrivacyEventItem[];
  total: number;
  totalDetections: number;
  totalMasked: number;
  totalBlocked: number;
}

export interface LatencyStats {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  avgMs: number | null;
}

export interface PerformanceResponse {
  taskLatency: LatencyStats;
  inferenceLatency: LatencyStats;
  taskSuccessRate: number | null;
  blockedRequestsCount: number;
  totalTasksCount: number;
  completedTasksCount: number;
  failedTasksCount: number;
  cpuPercent: number | null;
  memoryMB: number | null;
  note: string;
}

export interface PIIBenchmarkResult {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface BenchmarkRunResponse {
  suiteId: string;
  suiteVersion: string;
  isSimulated: boolean;
  ranAt: number;
  durationMs: number;
  piiDetection: PIIBenchmarkResult;
  redactionPrecision: number;
  falsePositiveRate: number;
  blockedUnsafeRequests: number;
  latencyMs: number;
  testCasesTotal: number;
  testCasesPassed: number;
  notes: string;
  limitations: string[];
}

// ─── API Functions ────────────────────────────────────────────────────────────

export const api = {
  health: () =>
    request<BackendHealth>('GET', '/api/health'),

  systemStatus: () =>
    request<BackendSystemStatus>('GET', '/api/system/status'),

  getTasks: (page = 1, pageSize = 20, sessionId?: string) => {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (sessionId) params.set('session_id', sessionId);
    return request<TaskHistoryResponse>('GET', `/api/tasks?${params}`);
  },

  recordTaskEvent: (body: {
    taskId: string;
    sessionId: string;
    eventType: 'started' | 'completed' | 'failed' | 'action_executed' | 'action_failed';
    actionType?: string;
    success?: boolean;
    latencyMs?: number;
    errorMessage?: string;
  }) => request<{ ok: boolean }>('POST', `/api/tasks/${body.taskId}/events`, body),

  clearTaskHistory: () =>
    request<{ ok: boolean }>('DELETE', '/api/tasks'),

  getPrivacyEvents: (limit = 100, sessionId?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (sessionId) params.set('session_id', sessionId);
    return request<PrivacyEventsResponse>('GET', `/api/privacy/events?${params}`);
  },

  recordPrivacyEvent: (body: {
    sessionId: string;
    taskId?: string;
    eventType: 'pii_detected' | 'privacy_gate' | 'network_blocked' | 'network_allowed';
    categories: string[];
    count: number;
    maskedCount: number;
    gateAllowed?: boolean;
    gateReason?: string;
    blockedCategories?: string[];
    payloadSizeBytes?: number;
    method?: string;
  }) => request<{ ok: boolean; eventId: string }>('POST', '/api/privacy/events', body),

  getPerformance: () =>
    request<PerformanceResponse>('GET', '/api/performance'),

  runBenchmark: (suiteVersion = 'v1') =>
    request<BenchmarkRunResponse>('POST', '/api/benchmark/run', {
      includeSyntheticOnly: true,
      suiteVersion,
    }),
};

// ─── Connection Status Monitor ────────────────────────────────────────────────

export type ConnectionStatus = 'checking' | 'online' | 'offline';

export function createConnectionMonitor(
  onStatusChange: (status: ConnectionStatus) => void,
  intervalMs = 10000,
): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let current: ConnectionStatus = 'checking';

  async function check() {
    const result = await api.health();
    const next: ConnectionStatus = result.ok ? 'online' : 'offline';
    if (next !== current) {
      current = next;
      onStatusChange(next);
    }
  }

  // Initial check
  check();
  timer = setInterval(check, intervalMs);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

// ─── WebSocket Client ─────────────────────────────────────────────────────────

export type WsEventHandler = (type: string, payload: unknown) => void;

export function createWebSocketClient(
  sessionId: string,
  onEvent: WsEventHandler,
): { disconnect: () => void; isConnected: () => boolean } {
  const wsUrl = BACKEND_BASE_URL.replace(/^http/, 'ws') + `/ws/${sessionId}`;
  let ws: WebSocket | null = null;
  let connected = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  function connect() {
    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        connected = true;
        pingInterval = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
        }, 20000);
      };

      ws.onmessage = (event) => {
        if (event.data === 'pong') return;
        try {
          const msg = JSON.parse(event.data as string) as { type: string; payload: unknown };
          onEvent(msg.type, msg.payload);
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        connected = false;
        if (pingInterval) clearInterval(pingInterval);
        // Reconnect after 5s
        setTimeout(connect, 5000);
      };

      ws.onerror = () => {
        connected = false;
      };
    } catch { /* ignore if WebSocket unavailable */ }
  }

  connect();

  return {
    disconnect: () => {
      if (ws) ws.close();
      if (pingInterval) clearInterval(pingInterval);
    },
    isConnected: () => connected,
  };
}
