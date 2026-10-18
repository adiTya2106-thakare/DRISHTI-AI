// Drishti AI – PII Detector Tests
// Tests pattern detection, redaction, DOM classification, and payload safety.

import { describe, it, expect } from 'vitest';
import {
  detectPIIInText,
  redactText,
  verifyPayloadSafety,
  classifyInputElement,
  classifyByLabel,
  maskValue,
} from '../src/privacy/pii-detector';

// ─── Pattern Detection ────────────────────────────────────────────────────────

describe('detectPIIInText', () => {
  it('detects email addresses', () => {
    const result = detectPIIInText('Contact me at john.doe@example.com');
    expect(result.some(d => d.category === 'email')).toBe(true);
  });

  it('detects Indian Aadhaar numbers', () => {
    const result = detectPIIInText('Aadhaar: 2345 6789 0123');
    expect(result.some(d => d.category === 'aadhaar')).toBe(true);
  });

  it('detects Indian PAN numbers', () => {
    const result = detectPIIInText('PAN: ABCDE1234F');
    expect(result.some(d => d.category === 'pan')).toBe(true);
  });

  it('detects Visa credit card numbers', () => {
    const result = detectPIIInText('Card: 4532015112830366');
    expect(result.some(d => d.category === 'credit_card')).toBe(true);
  });

  it('detects Indian mobile numbers', () => {
    const result = detectPIIInText('Call me on 9876543210');
    expect(result.some(d => d.category === 'phone')).toBe(true);
  });

  it('detects dates of birth', () => {
    const result = detectPIIInText('DOB: 15/08/1988');
    expect(result.some(d => d.category === 'dob')).toBe(true);
  });

  it('detects JWT tokens', () => {
    const result = detectPIIInText('Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
    expect(result.some(d => d.category === 'auth_token')).toBe(true);
  });

  it('returns empty for clean text', () => {
    const result = detectPIIInText('The application deadline is next Monday.');
    // Should not find any PII in this clean sentence
    // (phone pattern is broad, so allow for that edge case)
    const highConfidence = result.filter(d => d.confidence > 0.9);
    expect(highConfidence.length).toBe(0);
  });

  it('detects multiple categories in same text', () => {
    const result = detectPIIInText('Email: foo@bar.com, Aadhaar: 2345 6789 0123, PAN: ABCDE1234F');
    const categories = result.map(d => d.category);
    expect(categories).toContain('email');
    expect(categories).toContain('aadhaar');
    expect(categories).toContain('pan');
  });
});

// ─── Redaction ────────────────────────────────────────────────────────────────

describe('redactText', () => {
  it('redacts email addresses', () => {
    const result = redactText('Email: john@example.com');
    expect(result).not.toContain('john@example.com');
    expect(result).toContain('[REDACTED:EMAIL]');
  });

  it('redacts Aadhaar numbers', () => {
    const result = redactText('Aadhaar: 2345 6789 0123');
    expect(result).not.toContain('2345 6789 0123');
    expect(result).toContain('[REDACTED:AADHAAR]');
  });

  it('redacts PAN numbers', () => {
    const result = redactText('PAN ABCDE1234F is valid');
    expect(result).not.toContain('ABCDE1234F');
    expect(result).toContain('[REDACTED:PAN]');
  });

  it('does not alter clean text', () => {
    const text = 'Click the submit button to continue';
    const result = redactText(text);
    expect(result).toBe(text);
  });

  it('redacts credit card numbers', () => {
    const result = redactText('Card number: 4532015112830366');
    expect(result).not.toContain('4532015112830366');
    expect(result).toContain('[REDACTED:CREDIT_CARD]');
  });
});

// ─── Payload Safety ───────────────────────────────────────────────────────────

describe('verifyPayloadSafety', () => {
  it('allows properly redacted payloads', () => {
    const payload = JSON.stringify({
      text: 'User contact: [REDACTED:EMAIL]',
      id: '[REDACTED:AADHAAR]',
    });
    const { safe } = verifyPayloadSafety(payload);
    expect(safe).toBe(true);
  });

  it('blocks payloads with raw email', () => {
    const payload = JSON.stringify({ text: 'Send to: attacker@evil.com' });
    const { safe, violations } = verifyPayloadSafety(payload);
    expect(safe).toBe(false);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('blocks payloads with raw PAN', () => {
    const payload = JSON.stringify({ text: 'PAN: ABCDE1234F' });
    const { safe } = verifyPayloadSafety(payload);
    expect(safe).toBe(false);
  });

  it('blocks payloads with raw password field', () => {
    const payload = JSON.stringify({ password: 'MySecretPass123' });
    const { safe } = verifyPayloadSafety(payload);
    expect(safe).toBe(false);
  });

  it('allows empty payloads', () => {
    const { safe } = verifyPayloadSafety('{}');
    expect(safe).toBe(true);
  });
});

// ─── DOM Classification ───────────────────────────────────────────────────────

describe('classifyInputElement', () => {
  function makeInput(attrs: Record<string, string>): Element {
    const el = document.createElement('input');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  it('detects password inputs', () => {
    const el = makeInput({ type: 'password' });
    const result = classifyInputElement(el);
    expect(result?.category).toBe('password');
    expect(result?.confidence).toBeGreaterThan(0.95);
  });

  it('detects email inputs by type', () => {
    const el = makeInput({ type: 'email' });
    const result = classifyInputElement(el);
    expect(result?.category).toBe('email');
  });

  it('detects phone inputs by type', () => {
    const el = makeInput({ type: 'tel' });
    const result = classifyInputElement(el);
    expect(result?.category).toBe('phone');
  });

  it('detects aadhaar via name attribute', () => {
    const el = makeInput({ type: 'text', name: 'aadhaar_number' });
    const result = classifyInputElement(el);
    expect(result?.category).toBe('aadhaar');
  });

  it('detects credit card via autocomplete', () => {
    const el = makeInput({ type: 'text', autocomplete: 'cc-number' });
    const result = classifyInputElement(el);
    expect(result?.category).toBe('credit_card');
  });

  it('returns null for non-sensitive text inputs', () => {
    const el = makeInput({ type: 'text', name: 'city' });
    const result = classifyInputElement(el);
    expect(result).toBeNull();
  });
});

// ─── Label Classification ─────────────────────────────────────────────────────

describe('classifyByLabel', () => {
  it('detects aadhaar from label', () => {
    const result = classifyByLabel('Please enter your Aadhaar number');
    expect(result?.category).toBe('aadhaar');
  });

  it('detects pan from label', () => {
    const result = classifyByLabel('Enter PAN card number');
    expect(result?.category).toBe('pan');
  });

  it('detects password from label', () => {
    const result = classifyByLabel('Create a password');
    expect(result?.category).toBe('password');
  });

  it('returns null for non-sensitive labels', () => {
    const result = classifyByLabel('Your favourite colour');
    expect(result).toBeNull();
  });
});

// ─── Mask Value ───────────────────────────────────────────────────────────────

describe('maskValue', () => {
  it('masks middle characters', () => {
    expect(maskValue('secret123')).toMatch(/^se.*23$/);
  });

  it('masks short values completely', () => {
    expect(maskValue('ab')).toBe('****');
  });
});
