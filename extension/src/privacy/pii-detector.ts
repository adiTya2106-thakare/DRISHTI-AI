// Drishti AI – Privacy Layer: PII Detection
// Detects sensitive information via DOM inspection, pattern matching, and heuristics.
// NEVER stores or transmits raw PII values.

import type { PIIDetection, SensitiveCategory, DetectedElement, BoundingBox } from '../types';

// ─── PII Patterns ─────────────────────────────────────────────────────────────

const PII_PATTERNS: Record<SensitiveCategory, RegExp[]> = {
  email: [
    /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/,
  ],
  phone: [
    /(\+91[\-\s]?)?[6-9]\d{9}\b/,                          // Indian mobile
    /\b(\+?1[\-\s.]?)?\(?\d{3}\)?[\-\s.]?\d{3}[\-\s.]?\d{4}\b/, // US
    /\b\d{10,12}\b/,                                        // generic 10-12 digits
  ],
  aadhaar: [
    /\b[2-9]\d{3}[\s\-]?\d{4}[\s\-]?\d{4}\b/,             // 12-digit, starts 2-9
  ],
  pan: [
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/,                           // Indian PAN
  ],
  credit_card: [
    /\b4\d{3}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/,    // Visa
    /\b5[1-5]\d{2}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/, // MC
    /\b3[47]\d{2}[\s\-]?\d{6}[\s\-]?\d{5}\b/,             // Amex
    /\b6(?:011|5\d{2})[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/, // Discover
  ],
  account_number: [
    /\b\d{9,18}\b/,
  ],
  ssn: [
    /\b\d{3}[\-\s]\d{2}[\-\s]\d{4}\b/,
  ],
  password: [],  // detected via DOM, not patterns
  name: [],
  address: [],
  dob: [
    /\b(0?[1-9]|[12]\d|3[01])[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](19|20)\d{2}\b/,
    /\b(19|20)\d{2}[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](0?[1-9]|[12]\d|3[01])\b/,
  ],
  ip_address: [
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  ],
  api_key: [
    /\b[A-Za-z0-9_\-]{32,64}\b/,
  ],
  auth_token: [
    /\bey[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/, // JWT
    /\bBearer\s+[A-Za-z0-9_\-\.]+/i,
  ],
  generic_pii: [],
};

// Sensitive HTML input types
const SENSITIVE_INPUT_TYPES = new Set([
  'password', 'email', 'tel', 'number', 'credit-card',
]);

// Label keywords that suggest sensitivity
const SENSITIVE_LABEL_KEYWORDS: Record<SensitiveCategory, string[]> = {
  password: ['password', 'passwd', 'pass', 'pin', 'secret', 'otp', 'verification code'],
  email: ['email', 'e-mail', 'mail address'],
  phone: ['phone', 'mobile', 'cell', 'contact number', 'tel', 'telephone'],
  aadhaar: ['aadhaar', 'aadhar', 'uid', 'unique id', 'uidai'],
  pan: ['pan', 'pan card', 'permanent account', 'income tax'],
  credit_card: ['card number', 'credit card', 'debit card', 'cvv', 'cvc', 'expiry', 'card expiration'],
  account_number: ['account number', 'acct', 'bank account', 'ifsc', 'routing'],
  ssn: ['ssn', 'social security', 'national id', 'nin'],
  name: ['full name', 'first name', 'last name', 'surname'],
  address: ['billing address', 'home address', 'residential address', 'mailing address', 'street address', 'pincode', 'postal code', 'zip code'],
  dob: ['date of birth', 'dob', 'birth date', 'birthday'],
  ip_address: [],
  api_key: ['api key', 'api token', 'access key', 'secret key'],
  auth_token: ['token', 'bearer', 'jwt', 'session'],
  generic_pii: [],
};

// ─── Detection Functions ──────────────────────────────────────────────────────

/**
 * Detect PII in a text string using regex patterns.
 * Returns detections WITHOUT the actual matched values.
 */
export function detectPIIInText(text: string): PIIDetection[] {
  const detections: PIIDetection[] = [];
  if (!text || text.trim().length === 0) return detections;

  for (const [category, patterns] of Object.entries(PII_PATTERNS) as [SensitiveCategory, RegExp[]][]) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        detections.push({
          category,
          confidence: 0.85,
          method: 'pattern_match',
          location: 'text',
          masked: false,
        });
        break; // one detection per category per text block
      }
    }
  }

  return detections;
}

/**
 * Redact PII from text, replacing matched values with [REDACTED:category].
 */
export function redactText(text: string): string {
  let redacted = text;

  for (const [category, patterns] of Object.entries(PII_PATTERNS) as [SensitiveCategory, RegExp[]][]) {
    for (const pattern of patterns) {
      redacted = redacted.replace(new RegExp(pattern.source, 'gi'), `[REDACTED:${category.toUpperCase()}]`);
    }
  }

  return redacted;
}

/**
 * Classify a DOM input element and determine if it's sensitive.
 */
export function classifyInputElement(el: Element): PIIDetection | null {
  const tagName = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase() ?? '';
  const name = el.getAttribute('name')?.toLowerCase() ?? '';
  const id = el.getAttribute('id')?.toLowerCase() ?? '';
  const autocomplete = el.getAttribute('autocomplete')?.toLowerCase() ?? '';
  const placeholder = el.getAttribute('placeholder')?.toLowerCase() ?? '';

  // Direct type match
  if (type === 'password') {
    return { category: 'password', confidence: 0.99, method: 'dom_type', location: 'dom', masked: false };
  }
  if (type === 'email') {
    return { category: 'email', confidence: 0.95, method: 'dom_type', location: 'dom', masked: false };
  }
  if (type === 'tel') {
    return { category: 'phone', confidence: 0.90, method: 'dom_type', location: 'dom', masked: false };
  }

  // Autocomplete hints
  if (autocomplete.includes('cc-number') || autocomplete.includes('card')) {
    return { category: 'credit_card', confidence: 0.95, method: 'dom_type', location: 'dom', masked: false };
  }
  if (autocomplete.includes('email')) {
    return { category: 'email', confidence: 0.95, method: 'dom_type', location: 'dom', masked: false };
  }

  // Attribute keyword matching
  const allAttrs = `${name} ${id} ${autocomplete} ${placeholder}`.toLowerCase();

  for (const [cat, keywords] of Object.entries(SENSITIVE_LABEL_KEYWORDS) as [SensitiveCategory, string[]][]) {
    if (keywords.some(kw => allAttrs.includes(kw))) {
      return {
        category: cat,
        confidence: 0.80,
        method: 'label_match',
        location: 'dom',
        masked: false,
      };
    }
  }

  return null;
}

/**
 * Find the label text associated with a form element.
 */
export function findLabelText(el: Element, doc: Document = document): string {
  // 1. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.toLowerCase();

  // 2. aria-labelledby
  const labelledById = el.getAttribute('aria-labelledby');
  if (labelledById) {
    const labelEl = doc.getElementById(labelledById);
    if (labelEl) return (labelEl.textContent ?? '').toLowerCase();
  }

  // 3. Explicit <label for="id">
  const elId = el.getAttribute('id');
  if (elId) {
    const labelEl = doc.querySelector(`label[for="${elId}"]`);
    if (labelEl) return (labelEl.textContent ?? '').toLowerCase();
  }

  // 4. Wrapping label
  const parentLabel = el.closest('label');
  if (parentLabel) return (parentLabel.textContent ?? '').toLowerCase();

  return '';
}

/**
 * Check label text against sensitive keyword lists.
 */
export function classifyByLabel(labelText: string): PIIDetection | null {
  const lower = labelText.toLowerCase();
  for (const [cat, keywords] of Object.entries(SENSITIVE_LABEL_KEYWORDS) as [SensitiveCategory, string[]][]) {
    if (keywords.some(kw => lower.includes(kw))) {
      return {
        category: cat,
        confidence: 0.82,
        method: 'label_match',
        location: 'dom',
        masked: false,
      };
    }
  }
  return null;
}

/**
 * Scan all form inputs in the document, return detections.
 */
export function scanDOMForSensitiveFields(doc: Document = document): PIIDetection[] {
  const detections: PIIDetection[] = [];
  const inputs = doc.querySelectorAll('input, textarea, select');

  inputs.forEach(el => {
    // Check input type/attrs
    const typeDetection = classifyInputElement(el);
    if (typeDetection) {
      detections.push(typeDetection);
      return;
    }

    // Check label
    const labelText = findLabelText(el, doc);
    if (labelText) {
      const labelDetection = classifyByLabel(labelText);
      if (labelDetection) {
        detections.push(labelDetection);
      }
    }
  });

  return detections;
}

/**
 * Verify a payload string has no PII before transmission.
 * Returns { safe: boolean, violations: PIIDetection[] }.
 * This is the enforced OUTBOUND PRIVACY GATE.
 */
export function verifyPayloadSafety(payload: string): { safe: boolean; violations: PIIDetection[] } {
  const violations: PIIDetection[] = [];

  // Check for raw passwords (look for common JSON field names)
  const passwordFieldPattern = /"(?:password|passwd|secret|token|auth)["\s]*:\s*"([^"]{3,})"/gi;
  let m: RegExpExecArray | null;
  while ((m = passwordFieldPattern.exec(payload)) !== null) {
    // m[1] is the raw value — we found a non-redacted secret field
    if (!m[1].startsWith('[REDACTED:')) {
      violations.push({
        category: 'password',
        confidence: 0.99,
        method: 'pattern_match',
        location: 'payload',
        masked: false,
      });
    }
  }

  // Check for PII patterns in the payload text
  const textDetections = detectPIIInText(payload);
  // Only flag if the detected value is not already redacted
  for (const d of textDetections) {
    // If the payload contains a REDACTED tag for this category already, skip
    if (!payload.includes(`[REDACTED:${d.category.toUpperCase()}]`)) {
      violations.push(d);
    }
  }

  return { safe: violations.length === 0, violations };
}

/**
 * Mask a sensitive string value for display (show first 2 and last 2 chars).
 */
export function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
}

export { SENSITIVE_LABEL_KEYWORDS, PII_PATTERNS };
