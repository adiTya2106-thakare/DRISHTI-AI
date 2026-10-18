// Drishti AI – Privacy Gate Tests
// Proves the privacy gate enforcement: no sensitive payload gets through.

import { describe, it, expect } from 'vitest';
import { runPrivacyGate, isNavigationAllowed } from '../src/privacy/privacy-gate';
import type { DetectedElement } from '../src/types';

const CLEAN_TEXT = 'The application deadline is January 15th. Click Apply Now to start.';
const PII_TEXT = 'Contact john.doe@example.com, PAN: ABCDE1234F, phone: 9876543210';
const REDACTED_TEXT = 'Contact [REDACTED:EMAIL], PAN: [REDACTED:PAN], phone: [REDACTED:PHONE]';

const NORMAL_ELEMENT: DetectedElement = {
  id: 'drishti-button-001',
  type: 'button',
  label: 'Apply Now',
  selector: '#apply-btn',
  bbox: { x: 100, y: 200, width: 120, height: 40 },
  confidence: 0.95,
  source: 'dom',
  isSensitive: false,
  isInteractive: true,
  tagName: 'button',
  attributes: {},
};

const SENSITIVE_ELEMENT: DetectedElement = {
  id: 'drishti-input-002',
  type: 'input',
  label: 'Password',
  selector: '#password',
  bbox: { x: 100, y: 300, width: 200, height: 40 },
  confidence: 0.99,
  source: 'dom',
  isSensitive: true,
  sensitiveCategory: 'password',
  isInteractive: true,
  tagName: 'input',
  attributes: { type: 'password' },
};

// ─── Gate: Clean Context ──────────────────────────────────────────────────────

describe('runPrivacyGate — clean context', () => {
  it('allows clean text with no PII', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [NORMAL_ELEMENT], []);
    expect(ctx.privacyGateDecision.allowed).toBe(true);
    expect(ctx.privacyGateDecision.blockedCategories.length).toBe(0);
  });

  it('passes sanitized text through', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [NORMAL_ELEMENT], []);
    expect(ctx.sanitizedText).toContain('Apply Now');
  });

  it('sanitized elements do not contain sensitive labels', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [NORMAL_ELEMENT], []);
    expect(ctx.sanitizedElements[0].label).toBe('Apply Now');
    expect(ctx.sanitizedElements[0].isSensitiveRedacted).toBe(false);
  });
});

// ─── Gate: PII in Page Text ───────────────────────────────────────────────────

describe('runPrivacyGate — PII text', () => {
  it('detects PII in page text', () => {
    const ctx = runPrivacyGate(PII_TEXT, [], []);
    expect(ctx.detections.length).toBeGreaterThan(0);
  });

  it('redacts email from sanitized text', () => {
    const ctx = runPrivacyGate(PII_TEXT, [], []);
    expect(ctx.sanitizedText).not.toMatch(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    expect(ctx.sanitizedText).toContain('[REDACTED:EMAIL]');
  });

  it('redacts PAN from sanitized text', () => {
    const ctx = runPrivacyGate(PII_TEXT, [], []);
    expect(ctx.sanitizedText).not.toContain('ABCDE1234F');
    expect(ctx.sanitizedText).toContain('[REDACTED:PAN]');
  });

  it('allows transmission after successful redaction', () => {
    const ctx = runPrivacyGate(PII_TEXT, [], []);
    // After redaction, the gate should allow (text is now clean)
    expect(ctx.privacyGateDecision.allowed).toBe(true);
  });
});

// ─── Gate: Sensitive Elements ─────────────────────────────────────────────────

describe('runPrivacyGate — sensitive DOM elements', () => {
  it('masks sensitive element labels', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [SENSITIVE_ELEMENT], []);
    const maskedEl = ctx.sanitizedElements.find(e => e.id === SENSITIVE_ELEMENT.id);
    expect(maskedEl).toBeDefined();
    expect(maskedEl?.isSensitiveRedacted).toBe(true);
    expect(maskedEl?.label).toContain('[REDACTED:');
  });

  it('does not expose the raw original label value — replaces it with REDACTED tag', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [SENSITIVE_ELEMENT], []);
    const maskedEl = ctx.sanitizedElements.find(e => e.id === SENSITIVE_ELEMENT.id);
    // Original label was exactly "Password" — the masked label must be a REDACTED token, not the raw label
    expect(maskedEl?.label).not.toBe(SENSITIVE_ELEMENT.label);
    expect(maskedEl?.label).toMatch(/\[REDACTED:/i);
    expect(maskedEl?.isSensitiveRedacted).toBe(true);
  });

  it('records detection for sensitive element', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [SENSITIVE_ELEMENT], []);
    const detection = ctx.detections.find(d => d.elementId === SENSITIVE_ELEMENT.id);
    expect(detection).toBeDefined();
    expect(detection?.category).toBe('password');
    expect(detection?.masked).toBe(true);
  });

  it('populates redacted regions from sensitive elements', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [SENSITIVE_ELEMENT], [SENSITIVE_ELEMENT.bbox!]);
    expect(ctx.redactedRegions.length).toBeGreaterThan(0);
  });
});

// ─── Gate: Mixed Context ──────────────────────────────────────────────────────

describe('runPrivacyGate — mixed elements', () => {
  it('handles mix of sensitive and non-sensitive elements', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [NORMAL_ELEMENT, SENSITIVE_ELEMENT], []);
    const normalEl = ctx.sanitizedElements.find(e => e.id === NORMAL_ELEMENT.id);
    const sensitiveEl = ctx.sanitizedElements.find(e => e.id === SENSITIVE_ELEMENT.id);
    expect(normalEl?.isSensitiveRedacted).toBe(false);
    expect(sensitiveEl?.isSensitiveRedacted).toBe(true);
  });
});

// ─── Navigation Safety ────────────────────────────────────────────────────────

describe('isNavigationAllowed', () => {
  it('allows http URLs', () => {
    expect(isNavigationAllowed('http://example.com')).toEqual({ allowed: true, reason: expect.any(String) });
  });

  it('allows https URLs', () => {
    expect(isNavigationAllowed('https://example.com')).toEqual({ allowed: true, reason: expect.any(String) });
  });

  it('blocks javascript: URLs', () => {
    const result = isNavigationAllowed('javascript:alert(1)');
    expect(result.allowed).toBe(false);
  });

  it('blocks data: URLs', () => {
    const result = isNavigationAllowed('data:text/html,<h1>XSS</h1>');
    expect(result.allowed).toBe(false);
  });

  it('blocks about: URLs', () => {
    const result = isNavigationAllowed('about:blank');
    expect(result.allowed).toBe(false);
  });

  it('blocks chrome-extension: URLs', () => {
    const result = isNavigationAllowed('chrome-extension://abc123/popup.html');
    expect(result.allowed).toBe(false);
  });
});

// ─── Leakage Prevention ───────────────────────────────────────────────────────

describe('privacy gate — leakage prevention', () => {
  it('sanitized payload never contains raw Aadhaar', () => {
    const text = 'Aadhaar: 2345 6789 0123, name: John Doe';
    const ctx = runPrivacyGate(text, [], []);
    expect(ctx.sanitizedText).not.toContain('2345 6789 0123');
  });

  it('sanitized payload never contains raw credit card', () => {
    const text = 'Card: 4532015112830366 exp 12/25 cvv 123';
    const ctx = runPrivacyGate(text, [], []);
    expect(ctx.sanitizedText).not.toContain('4532015112830366');
  });

  it('sanitized payload never contains raw PAN', () => {
    const text = 'Income tax PAN ABCDE1234F filed';
    const ctx = runPrivacyGate(text, [], []);
    expect(ctx.sanitizedText).not.toContain('ABCDE1234F');
  });

  it('gate version is recorded', () => {
    const ctx = runPrivacyGate(CLEAN_TEXT, [], []);
    expect(ctx.privacyGateDecision.gateVersion).toBe('1.0');
  });

  it('gate timestamp is recent', () => {
    const before = Date.now();
    const ctx = runPrivacyGate(CLEAN_TEXT, [], []);
    const after = Date.now();
    expect(ctx.privacyGateDecision.timestamp).toBeGreaterThanOrEqual(before);
    expect(ctx.privacyGateDecision.timestamp).toBeLessThanOrEqual(after);
  });
});
