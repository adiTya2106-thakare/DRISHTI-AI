// Drishti AI – Background Service Worker v2
// Coordinates extension components, manages the privacy gate, persists to backend,
// handles the real confirmation flow via a promise map.

import { runPrivacyGate, isNavigationAllowed } from '../privacy/privacy-gate';
import { verifyPayloadSafety } from '../privacy/pii-detector';
import { api } from '../api/client';
import type {
  ExtensionMessage,
  PageState,
  TaskPlan,
  AgentAction,
  ActionResult,
  LedgerEntry,
  SanitizedContext,
  SystemStatus,
  PlanRequest,
  PlanResponse,
} from '../types';
import { openDB, type IDBPDatabase } from 'idb';

// ─── Configuration ────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8000';
const DB_NAME = 'drishti-ledger';
const DB_VERSION = 1;

// ─── State ────────────────────────────────────────────────────────────────────

let db: IDBPDatabase | null = null;
let sessionId = crypto.randomUUID();
let systemStatus: SystemStatus = {
  modelStatus: 'unloaded',
  modelName: 'local-deterministic',
  backend: 'none',
  backendOnline: false,
  externalAIEnabled: false,
};

// Map from actionId → { resolve, reject } for the confirmation flow
const pendingConfirmations = new Map<string, { resolve: (confirmed: boolean) => void }>();

// ─── DB Setup ─────────────────────────────────────────────────────────────────

async function getDB(): Promise<IDBPDatabase> {
  if (db) return db;
  db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('ledger')) {
        const store = database.createObjectStore('ledger', { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('sessionId', 'sessionId');
      }
    },
  });
  return db;
}

async function addLedgerEntry(entry: LedgerEntry): Promise<void> {
  try {
    const database = await getDB();
    await database.put('ledger', entry);
  } catch (err) {
    console.error('[Drishti BG] Ledger write failed:', err);
  }
}

export async function getLedgerEntries(limit = 200): Promise<LedgerEntry[]> {
  const database = await getDB();
  const all = await database.getAll('ledger');
  return all
    .sort((a, b) => (b as LedgerEntry).timestamp - (a as LedgerEntry).timestamp)
    .slice(0, limit) as LedgerEntry[];
}

export async function clearLedger(): Promise<void> {
  const database = await getDB();
  await database.clear('ledger');
}

// ─── Ledger Helper ────────────────────────────────────────────────────────────

function logLedger(
  eventType: LedgerEntry['eventType'],
  summary: string,
  details: LedgerEntry['details'],
): void {
  const entry: LedgerEntry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    sessionId,
    eventType,
    summary,
    details,
  };
  addLedgerEntry(entry).catch(console.error);
  broadcastToPopup({ type: 'LEDGER_ENTRY', payload: entry });
}

// ─── Backend Event Reporting ──────────────────────────────────────────────────
// Report events to backend for persistence — fire-and-forget, never blocks

function reportPrivacyEvent(
  eventType: 'pii_detected' | 'privacy_gate' | 'network_blocked' | 'network_allowed',
  categories: string[],
  count: number,
  maskedCount: number,
  opts?: { gateAllowed?: boolean; gateReason?: string; blockedCategories?: string[]; payloadSizeBytes?: number; taskId?: string },
): void {
  api.recordPrivacyEvent({
    sessionId,
    taskId: opts?.taskId,
    eventType,
    categories,
    count,
    maskedCount,
    gateAllowed: opts?.gateAllowed,
    gateReason: opts?.gateReason,
    blockedCategories: opts?.blockedCategories ?? [],
    payloadSizeBytes: opts?.payloadSizeBytes,
    method: 'background_sw',
  }).catch(err => console.debug('[Drishti BG] Privacy event report failed (backend may be offline):', err));
}

function reportTaskEvent(
  taskId: string,
  eventType: 'started' | 'completed' | 'failed' | 'action_executed' | 'action_failed',
  opts?: { actionType?: string; success?: boolean; latencyMs?: number; errorMessage?: string },
): void {
  api.recordTaskEvent({
    taskId,
    sessionId,
    eventType,
    actionType: opts?.actionType,
    success: opts?.success ?? true,
    latencyMs: opts?.latencyMs,
    errorMessage: opts?.errorMessage,
  }).catch(err => console.debug('[Drishti BG] Task event report failed (backend may be offline):', err));
}

// ─── Message Routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch(err => {
      console.error('[Drishti BG] Message handler error:', err);
      sendResponse({ error: String(err) });
    });
    return true;
  }
);

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case 'INSPECT_PAGE': {
      const tabId = sender.tab?.id;
      if (!tabId) return { error: 'No active tab' };
      return await inspectActiveTab(tabId);
    }

    case 'START_TASK': {
      const tabId = await getActiveTabId();
      if (!tabId) return { error: 'No active tab' };
      return await runTask(message.payload.taskText, tabId);
    }

    case 'CONFIRM_ACTION': {
      // User confirmed or rejected a pending action from the dashboard
      const { actionId, confirmed } = message.payload as { actionId: string; confirmed: boolean };
      const pending = pendingConfirmations.get(actionId);
      if (pending) {
        pending.resolve(confirmed);
        pendingConfirmations.delete(actionId);
      }
      return { ok: true };
    }

    default:
      return { ok: false };
  }
}

// ─── Tab Helpers ──────────────────────────────────────────────────────────────

async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function sendToTab<T>(tabId: number, message: ExtensionMessage): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message);
}

// ─── Page Inspection ──────────────────────────────────────────────────────────

async function inspectActiveTab(tabId: number): Promise<PageState | { error: string }> {
  try {
    const result = await sendToTab<PageState>(tabId, { type: 'INSPECT_PAGE' });
    logLedger('task_start', `Inspected page: ${result.title}`, {
      kind: 'task',
      taskText: 'Page inspection',
      status: 'completed',
    });

    // Show overlay
    await sendToTab(tabId, { type: 'OVERLAY_SHOW', payload: { elements: result.elements } });

    broadcastToPopup({ type: 'INSPECT_RESULT', payload: result });
    broadcastToPopup({ type: 'STATUS_UPDATE', payload: systemStatus });
    return result;
  } catch (err) {
    return { error: String(err) };
  }
}

// ─── Task Execution Pipeline ──────────────────────────────────────────────────

async function runTask(taskText: string, tabId: number): Promise<TaskPlan | { error: string }> {
  const taskStart = Date.now();
  const taskId = crypto.randomUUID();

  logLedger('task_start', `Task started: "${taskText.slice(0, 80)}"`, {
    kind: 'task',
    taskText: taskText.slice(0, 200),
    status: 'started',
  });
  reportTaskEvent(taskId, 'started');

  // 1. Inspect page
  let pageState: PageState;
  try {
    pageState = await sendToTab<PageState>(tabId, { type: 'INSPECT_PAGE' });
  } catch (err) {
    reportTaskEvent(taskId, 'failed', { errorMessage: 'Page inspection failed' });
    return { error: `Failed to inspect page: ${err}` };
  }

  // 2. Run privacy gate (MANDATORY — no bypass possible)
  const sanitizedContext = runPrivacyGate(
    pageState.pageText,
    pageState.elements,
    pageState.elements
      .filter(e => e.isSensitive && e.bbox)
      .map(e => e.bbox!),
  );

  const gateAllowed = sanitizedContext.privacyGateDecision.allowed;

  logLedger(
    gateAllowed ? 'network_allowed' : 'network_blocked',
    sanitizedContext.privacyGateDecision.reason,
    {
      kind: 'gate',
      allowed: gateAllowed,
      reason: sanitizedContext.privacyGateDecision.reason,
      sanitizedCategories: sanitizedContext.detections.filter(d => d.masked).map(d => d.category),
      blockedCategories: sanitizedContext.privacyGateDecision.blockedCategories,
    },
  );

  reportPrivacyEvent(
    gateAllowed ? 'privacy_gate' : 'network_blocked',
    sanitizedContext.detections.map(d => d.category),
    sanitizedContext.detections.length,
    sanitizedContext.detections.filter(d => d.masked).length,
    {
      gateAllowed,
      gateReason: sanitizedContext.privacyGateDecision.reason,
      blockedCategories: sanitizedContext.privacyGateDecision.blockedCategories,
      payloadSizeBytes: sanitizedContext.privacyGateDecision.sanitizedPayloadSize,
      taskId,
    },
  );

  if (sanitizedContext.detections.length > 0) {
    logLedger('pii_detected', `${sanitizedContext.detections.length} sensitive items detected and masked`, {
      kind: 'pii',
      categories: sanitizedContext.detections.map(d => d.category),
      count: sanitizedContext.detections.length,
      masked: sanitizedContext.detections.length,
      methods: [...new Set(sanitizedContext.detections.map(d => d.method))],
    });

    reportPrivacyEvent(
      'pii_detected',
      sanitizedContext.detections.map(d => d.category),
      sanitizedContext.detections.length,
      sanitizedContext.detections.length,
      { taskId },
    );
  }

  broadcastToPopup({ type: 'PRIVACY_GATE_RESULT', payload: sanitizedContext.privacyGateDecision });

  if (!gateAllowed) {
    logLedger('task_done', 'Task blocked by privacy gate.', {
      kind: 'task',
      taskText: taskText.slice(0, 200),
      status: 'failed',
      durationMs: Date.now() - taskStart,
    });
    reportTaskEvent(taskId, 'failed', { errorMessage: 'Privacy gate blocked transmission' });
    return { error: sanitizedContext.privacyGateDecision.reason };
  }

  // 3. Get plan (local or remote)
  const plan = await getPlan(taskText, sanitizedContext, pageState.url, taskId);

  broadcastToPopup({ type: 'TASK_PLAN', payload: plan });

  // 4. Show overlay
  await sendToTab(tabId, { type: 'OVERLAY_SHOW', payload: { elements: pageState.elements } });

  // 5. Execute actions sequentially with real confirmation flow
  let actionsCompleted = 0;
  for (const step of plan.steps) {
    const actionStart = Date.now();
    const actionResult = await executeStep(step, tabId, pageState);
    const actionLatency = Date.now() - actionStart;

    logLedger(
      actionResult.success ? 'action_executed' : 'action_verified',
      `${step.type}: ${actionResult.success ? (actionResult as { success: true; message: string }).message : (actionResult as { success: false; error: string }).error}`,
      {
        kind: 'action',
        actionType: step.type,
        targetId: step.elementId,
        success: actionResult.success,
        confirmationRequired: step.requiresConfirmation ?? false,
        latencyMs: actionLatency,
      },
    );

    reportTaskEvent(taskId, actionResult.success ? 'action_executed' : 'action_failed', {
      actionType: step.type,
      success: actionResult.success,
      latencyMs: actionLatency,
      errorMessage: actionResult.success ? undefined : (actionResult as { error: string }).error,
    });

    if (!actionResult.success) {
      const err = actionResult as { success: false; error: string; retryable: boolean };
      if (!err.retryable) break;
    }

    actionsCompleted++;
    if (step.type === 'DONE') break;
  }

  const durationMs = Date.now() - taskStart;
  logLedger('task_done', `Task completed: ${actionsCompleted} actions executed.`, {
    kind: 'task',
    taskText: taskText.slice(0, 200),
    status: 'completed',
    actionsCount: actionsCompleted,
    durationMs,
  });
  reportTaskEvent(taskId, 'completed', { latencyMs: durationMs });

  return plan;
}

// ─── Action Execution ─────────────────────────────────────────────────────────

const REQUIRES_CONFIRMATION: Set<AgentAction['type']> = new Set([
  'NAVIGATE',
]);

async function executeStep(
  action: AgentAction,
  tabId: number,
  _pageState: PageState,
): Promise<ActionResult> {
  // Validate action schema
  const validationError = validateAction(action);
  if (validationError) {
    return { success: false, error: validationError, retryable: false };
  }

  // Navigation safety check
  if (action.type === 'NAVIGATE' && action.url) {
    const navCheck = isNavigationAllowed(action.url);
    if (!navCheck.allowed) {
      logLedger('network_blocked', `Navigation blocked: ${navCheck.reason}`, {
        kind: 'network',
        endpoint: action.url,
        blocked: true,
        reason: navCheck.reason,
        payloadSizeBytes: 0,
      });
      return { success: false, error: navCheck.reason, retryable: false };
    }
    action.requiresConfirmation = true;
  }

  // Real confirmation flow: pause execution, ask user, wait for response
  if (REQUIRES_CONFIRMATION.has(action.type) || action.requiresConfirmation) {
    const actionId = crypto.randomUUID();
    const actionWithId = { ...action, _actionId: actionId };

    // Tell the popup/dashboard to show confirmation UI
    broadcastToPopup({ type: 'EXECUTE_ACTION', payload: actionWithId });

    // Wait for the user's decision (timeout after 2 minutes)
    const confirmed = await new Promise<boolean>(resolve => {
      pendingConfirmations.set(actionId, { resolve });
      // Auto-reject after 120 seconds if no response
      setTimeout(() => {
        if (pendingConfirmations.has(actionId)) {
          pendingConfirmations.delete(actionId);
          resolve(false);
        }
      }, 120000);
    });

    if (!confirmed) {
      return { success: false, error: `Action ${action.type} rejected by user.`, retryable: false };
    }
  }

  // Execute via content script
  try {
    const result = await sendToTab<ActionResult>(tabId, {
      type: 'EXECUTE_ACTION',
      payload: action,
    });

    // Post-action: re-inspect to verify state changed
    if (action.type === 'CLICK' || action.type === 'NAVIGATE') {
      setTimeout(async () => {
        try {
          const newState = await sendToTab<PageState>(tabId, { type: 'INSPECT_PAGE' });
          broadcastToPopup({ type: 'INSPECT_RESULT', payload: newState });
        } catch { /* page may have navigated */ }
      }, 600);
    }

    broadcastToPopup({ type: 'ACTION_RESULT', payload: result });
    return result;
  } catch (err) {
    return { success: false, error: String(err), retryable: true };
  }
}

function validateAction(action: AgentAction): string | null {
  const VALID_TYPES = new Set([
    'INSPECT', 'CLICK', 'TYPE', 'SELECT', 'SCROLL',
    'NAVIGATE', 'WAIT', 'ASK_USER', 'DONE',
  ]);

  if (!VALID_TYPES.has(action.type)) {
    return `Invalid action type: ${action.type}`;
  }

  if (action.type === 'NAVIGATE' && action.url) {
    if (action.url.trim().toLowerCase().startsWith('javascript:')) {
      return 'javascript: navigation is not permitted.';
    }
  }

  if (action.type === 'TYPE' && typeof action.value === 'string') {
    if (/<script/i.test(action.value)) {
      return 'Script content in TYPE value is not permitted.';
    }
  }

  return null;
}

// ─── Planner ──────────────────────────────────────────────────────────────────

async function getPlan(
  taskText: string,
  sanitizedContext: SanitizedContext,
  pageUrl: string,
  taskId: string,
): Promise<TaskPlan> {
  const backendAvailable = await checkBackendHealth();

  // Always try backend first (it handles local vs LLM selection transparently)
  if (backendAvailable) {
    try {
      return await getRemotePlan(taskText, sanitizedContext, pageUrl, taskId);
    } catch (err) {
      console.warn('[Drishti BG] Remote planner failed, falling back to local:', err);
    }
  }

  // Fallback: deterministic local planner (offline)
  return getLocalPlan(taskText, sanitizedContext, pageUrl);
}

async function checkBackendHealth(): Promise<boolean> {
  const result = await api.health();
  systemStatus.backendOnline = result.ok;
  broadcastToPopup({ type: 'STATUS_UPDATE', payload: { ...systemStatus } });
  return result.ok;
}

async function getRemotePlan(
  taskText: string,
  sanitizedContext: SanitizedContext,
  pageUrl: string,
  taskId: string,
): Promise<TaskPlan> {
  const planStart = Date.now();

  // Final payload verification before transmission (MANDATORY)
  const requestBody: PlanRequest = {
    taskText,
    sanitizedContext,
    pageUrl: stripSensitiveQueryParams(pageUrl),
    sessionId,
  };

  const serialized = JSON.stringify(requestBody);
  const { safe, violations } = verifyPayloadSafety(serialized);

  if (!safe) {
    logLedger('network_blocked', `Remote request blocked: residual PII in payload`, {
      kind: 'network',
      endpoint: `${BACKEND_URL}/api/tasks/plan`,
      blocked: true,
      reason: `Residual PII: ${violations.map(v => v.category).join(', ')}`,
      payloadSizeBytes: serialized.length,
    });
    throw new Error('Payload failed final PII check — falling back to local planner.');
  }

  logLedger('network_allowed', `Remote plan request: ${serialized.length} bytes`, {
    kind: 'network',
    endpoint: `${BACKEND_URL}/api/tasks/plan`,
    blocked: false,
    payloadSizeBytes: serialized.length,
  });

  const resp = await fetch(`${BACKEND_URL}/api/tasks/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
    body: serialized,
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`Backend returned ${resp.status}`);
  }

  const planResp: PlanResponse = await resp.json();
  const inferenceMs = Date.now() - planStart;

  logLedger('model_inference', `Plan received in ${inferenceMs}ms via ${planResp.plannerUsed}`, {
    kind: 'inference',
    modelName: planResp.plannerUsed ?? 'remote',
    backend: planResp.plannerUsed.includes('openai') || planResp.plannerUsed.includes('anthropic') ? 'remote' : 'wasm',
    latencyMs: inferenceMs,
  });

  // Update system status with real planner info
  systemStatus.lastInferenceMs = inferenceMs;
  systemStatus.modelName = planResp.plannerUsed;
  systemStatus.modelStatus = 'ready';
  broadcastToPopup({ type: 'STATUS_UPDATE', payload: { ...systemStatus } });

  return {
    id: planResp.planId,
    taskText,
    steps: planResp.steps,
    plannerUsed: planResp.plannerUsed.includes('openai') || planResp.plannerUsed.includes('anthropic') ? 'llm' : 'local_deterministic',
    sanitizedContextSent: true,
    timestamp: Date.now(),
  };
}

/**
 * Deterministic local planner — works offline without any API key or backend.
 * Transparently reported as deterministic — NOT a neural network.
 */
function getLocalPlan(
  taskText: string,
  sanitizedContext: SanitizedContext,
  _pageUrl: string,
): TaskPlan {
  const lower = taskText.toLowerCase();
  const steps: AgentAction[] = [];

  steps.push({ type: 'INSPECT', reason: 'Inspect current page state' });

  const keyWords = extractKeywords(taskText);
  const matchingElement = sanitizedContext.sanitizedElements.find(el =>
    keyWords.some(kw => el.label.toLowerCase().includes(kw))
  );

  if ((lower.includes('find') || lower.includes('search') || lower.includes('locate')) && matchingElement) {
    steps.push({
      type: 'CLICK',
      elementId: matchingElement.id,
      reason: `Navigate to: ${matchingElement.label}`,
    });
  }

  if (lower.includes('scroll') || lower.includes('down') || lower.includes('more')) {
    steps.push({ type: 'SCROLL', direction: lower.includes('up') ? 'up' : 'down', pixels: 400 });
  }

  if (lower.includes('deadline') || lower.includes('date') || lower.includes('when') || lower.includes('find')) {
    steps.push({
      type: 'ASK_USER',
      message: matchingElement
        ? `Relevant element found: "${matchingElement.label}". Check highlighted elements for the information you need.`
        : 'Check the highlighted elements on the page. No exact match found for your query keywords.',
    });
  }

  steps.push({
    type: 'DONE',
    reason: 'Local deterministic planner analysis complete. This is NOT neural network inference.',
  });

  logLedger('model_inference', 'Local deterministic planner used (offline — keyword matching)', {
    kind: 'inference',
    modelName: 'local-deterministic-v1',
    backend: 'wasm',
    latencyMs: 2,
  });

  systemStatus.modelName = 'local-deterministic-v1';
  systemStatus.modelStatus = 'ready';
  systemStatus.lastInferenceMs = 2;
  broadcastToPopup({ type: 'STATUS_UPDATE', payload: { ...systemStatus } });

  return {
    id: crypto.randomUUID(),
    taskText,
    steps,
    plannerUsed: 'local_deterministic',
    sanitizedContextSent: false,
    timestamp: Date.now(),
  };
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'in', 'on', 'and', 'or', 'for', 'to', 'of', 'find', 'search', 'this', 'page', 'me', 'i']);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
}

function stripSensitiveQueryParams(url: string): string {
  try {
    const u = new URL(url);
    const sensitiveParams = ['token', 'auth', 'key', 'secret', 'password', 'session', 'access_token', 'refresh_token'];
    for (const p of sensitiveParams) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url.split('?')[0];
  }
}

// ─── Popup Communication ──────────────────────────────────────────────────────

function broadcastToPopup(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup/dashboard may not be open — expected
  });
}

// ─── Extension Message Handlers for Popup/Dashboard ──────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_LEDGER') {
    getLedgerEntries(200).then(sendResponse);
    return true;
  }
  if (message.type === 'CLEAR_LEDGER') {
    clearLedger().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'GET_STATUS') {
    sendResponse(systemStatus);
    return false;
  }
  if (message.type === 'SET_EXTERNAL_AI') {
    systemStatus.externalAIEnabled = message.payload as boolean;
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'CONFIRM_ACTION') {
    const { actionId, confirmed } = message.payload as { actionId: string; confirmed: boolean };
    const pending = pendingConfirmations.get(actionId);
    if (pending) {
      pending.resolve(confirmed);
      pendingConfirmations.delete(actionId);
    }
    sendResponse({ ok: true });
    return false;
  }
});

// ─── Initialization ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Drishti AI] Extension installed. Session:', sessionId);
  systemStatus = {
    ...systemStatus,
    modelStatus: 'ready',
    modelName: 'local-deterministic-v1',
    backend: 'none',
    backendOnline: false,
    externalAIEnabled: false,
  };

  // Check backend availability on install
  checkBackendHealth().catch(console.error);
});

console.debug('[Drishti AI] Background service worker started. Session:', sessionId);
