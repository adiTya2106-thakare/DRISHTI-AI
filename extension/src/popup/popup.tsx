// Drishti AI – Extension Popup
// Compact task interface. Opens dashboard in full tab.

import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type { SystemStatus, PageState, TaskPlan, PrivacyGateDecision, LedgerEntry } from '../types';

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  container: {
    padding: '16px',
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '12px',
  },
  header: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    borderBottom: '1px solid #1a2d4a',
    paddingBottom: '10px',
  },
  logo: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '8px',
  },
  logoIcon: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #00d4ff 0%, #7c5cd8 100%)',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    fontSize: 14,
    fontWeight: 'bold' as const,
    color: '#0a1428',
  },
  logoText: {
    fontSize: 16,
    fontWeight: 700 as const,
    letterSpacing: '0.05em',
    color: '#00d4ff',
  },
  statusDot: (online: boolean) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: online ? '#22dd55' : '#ff4040',
    display: 'inline-block' as const,
    marginRight: 6,
  }),
  statusText: { fontSize: 11, color: '#8899bb' },
  input: {
    width: '100%',
    background: '#111e36',
    border: '1px solid #1e3a5f',
    borderRadius: 6,
    color: '#e0eaff',
    padding: '10px 12px',
    fontSize: 13,
    fontFamily: 'inherit',
    resize: 'vertical' as const,
    minHeight: 80,
    outline: 'none',
  },
  button: (disabled: boolean) => ({
    background: disabled ? '#1a2d4a' : 'linear-gradient(135deg, #0077cc 0%, #7c5cd8 100%)',
    color: disabled ? '#445566' : '#ffffff',
    border: 'none',
    borderRadius: 6,
    padding: '10px 16px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13,
    fontWeight: 600 as const,
    width: '100%',
    transition: 'opacity 0.2s',
  }),
  inspectBtn: {
    background: 'transparent',
    border: '1px solid #1e3a5f',
    borderRadius: 6,
    color: '#00d4ff',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 12,
    width: '100%',
  },
  dashboardBtn: {
    background: 'transparent',
    border: '1px solid #7c5cd8',
    borderRadius: 6,
    color: '#7c5cd8',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 12,
    width: '100%',
  },
  statusCard: {
    background: '#0f1e36',
    border: '1px solid #1a2d4a',
    borderRadius: 8,
    padding: '10px 12px',
  },
  gateCard: (allowed: boolean) => ({
    background: allowed ? '#0a1e14' : '#1e0a0a',
    border: `1px solid ${allowed ? '#22dd55' : '#ff4040'}`,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 12,
  }),
  planCard: {
    background: '#0f1e36',
    border: '1px solid #1a2d4a',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 12,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700 as const,
    letterSpacing: '0.12em',
    color: '#4a6a9a',
    textTransform: 'uppercase' as const,
    marginBottom: 6,
  },
  pill: (color: string) => ({
    display: 'inline-block' as const,
    background: color + '22',
    border: `1px solid ${color}`,
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 10,
    color,
    marginRight: 4,
    marginBottom: 2,
  }),
};

// ─── Component ────────────────────────────────────────────────────────────────

function Popup() {
  const [taskText, setTaskText] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [pageState, setPageState] = useState<PageState | null>(null);
  const [gateDecision, setGateDecision] = useState<PrivacyGateDecision | null>(null);
  const [taskPlan, setTaskPlan] = useState<TaskPlan | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [recentLedger, setRecentLedger] = useState<LedgerEntry[]>([]);

  useEffect(() => {
    // Get initial status
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp: SystemStatus) => {
      if (resp) setStatus(resp);
    });

    // Get recent ledger entries
    chrome.runtime.sendMessage({ type: 'GET_LEDGER' }, (entries: LedgerEntry[]) => {
      if (entries) setRecentLedger(entries.slice(0, 5));
    });

    // Listen for messages from background
    const listener = (message: { type: string; payload?: unknown }) => {
      if (message.type === 'STATUS_UPDATE') setStatus(message.payload as SystemStatus);
      if (message.type === 'INSPECT_RESULT') setPageState(message.payload as PageState);
      if (message.type === 'PRIVACY_GATE_RESULT') setGateDecision(message.payload as PrivacyGateDecision);
      if (message.type === 'TASK_PLAN') {
        setTaskPlan(message.payload as TaskPlan);
        setLoading(false);
      }
      if (message.type === 'ERROR') {
        setLastError((message.payload as { message: string }).message);
        setLoading(false);
      }
      if (message.type === 'LEDGER_ENTRY') {
        setRecentLedger(prev => [message.payload as LedgerEntry, ...prev].slice(0, 5));
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleInspect = useCallback(async () => {
    setLastError(null);
    setLoading(true);
    chrome.runtime.sendMessage({ type: 'INSPECT_PAGE' }, () => {
      setLoading(false);
    });
  }, []);

  const handleStartTask = useCallback(async () => {
    if (!taskText.trim()) return;
    setLastError(null);
    setLoading(true);
    setGateDecision(null);
    setTaskPlan(null);
    chrome.runtime.sendMessage({ type: 'START_TASK', payload: { taskText } });
  }, [taskText]);

  const openDashboard = useCallback(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/index.html') });
  }, []);

  return (
    <div style={S.container}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.logo}>
          <div style={S.logoIcon}>D</div>
          <span style={S.logoText}>DRISHTI AI</span>
        </div>
        <div>
          <span style={S.statusDot(status?.backendOnline ?? false)} />
          <span style={S.statusText}>
            {status?.backendOnline ? 'Backend Online' : 'Offline Mode'}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={S.statusCard}>
        <div style={S.sectionTitle}>System Status</div>
        <div style={{ fontSize: 12, color: '#8899bb', lineHeight: 1.7 }}>
          <div>Model: <span style={{ color: '#00d4ff' }}>{status?.modelName ?? 'local-deterministic'}</span></div>
          <div>External AI: <span style={{ color: status?.externalAIEnabled ? '#22dd55' : '#ff9900' }}>
            {status?.externalAIEnabled ? 'Enabled ⚠' : 'Disabled (Privacy Mode)'}
          </span></div>
          {pageState && <div>Page: <span style={{ color: '#e0eaff' }}>{pageState.elements.length} elements</span></div>}
        </div>
      </div>

      {/* Task Input */}
      <div>
        <div style={S.sectionTitle}>Task Command</div>
        <textarea
          style={S.input}
          value={taskText}
          onChange={e => setTaskText(e.target.value)}
          placeholder="e.g. Find the application deadline and identify the application link"
          onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleStartTask(); }}
        />
      </div>

      {/* Buttons */}
      <button style={S.button(loading || !taskText.trim())} onClick={handleStartTask} disabled={loading || !taskText.trim()}>
        {loading ? '⟳ Processing...' : '▶ Run Task'}
      </button>
      <button style={S.inspectBtn} onClick={handleInspect} disabled={loading}>
        🔍 Inspect Page
      </button>
      <button style={S.dashboardBtn} onClick={openDashboard}>
        ↗ Open Full Dashboard
      </button>

      {/* Error */}
      {lastError && (
        <div style={{ ...S.gateCard(false), fontSize: 12 }}>
          <div style={S.sectionTitle}>Error</div>
          <div style={{ color: '#ff8080' }}>{lastError}</div>
        </div>
      )}

      {/* Privacy Gate */}
      {gateDecision && (
        <div style={S.gateCard(gateDecision.allowed)}>
          <div style={S.sectionTitle}>Privacy Gate {gateDecision.allowed ? '✓ ALLOWED' : '✗ BLOCKED'}</div>
          <div style={{ color: gateDecision.allowed ? '#22dd55' : '#ff6060', marginBottom: 4 }}>
            {gateDecision.reason}
          </div>
          <div style={{ color: '#8899bb' }}>
            {gateDecision.detectionsCount} item(s) detected • {new Date(gateDecision.timestamp).toLocaleTimeString()}
          </div>
        </div>
      )}

      {/* Task Plan */}
      {taskPlan && (
        <div style={S.planCard}>
          <div style={S.sectionTitle}>Action Plan ({taskPlan.plannerUsed})</div>
          {taskPlan.steps.slice(0, 4).map((step, i) => (
            <div key={i} style={{ marginBottom: 3, color: '#c0d0ee' }}>
              <span style={S.pill('#00d4ff')}>{step.type}</span>
              {step.reason ?? step.selector ?? step.value ?? ''}
            </div>
          ))}
          {taskPlan.steps.length > 4 && (
            <div style={{ color: '#4a6a9a', fontSize: 11 }}>+{taskPlan.steps.length - 4} more steps…</div>
          )}
        </div>
      )}

      {/* Recent Ledger */}
      {recentLedger.length > 0 && (
        <div style={S.statusCard}>
          <div style={S.sectionTitle}>Recent Activity</div>
          {recentLedger.map((entry, i) => (
            <div key={i} style={{ fontSize: 11, color: '#8899bb', borderBottom: '1px solid #1a2d4a', padding: '3px 0' }}>
              <span style={{ color: '#00d4ff' }}>{entry.eventType}</span> — {entry.summary.slice(0, 50)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────

const root = document.getElementById('popup-root');
if (root) {
  createRoot(root).render(<Popup />);
}
