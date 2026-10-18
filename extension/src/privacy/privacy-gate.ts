// Drishti AI – Privacy Gate
// The single enforced outbound gate. All external transmission MUST pass through here.
// If this gate blocks, nothing is sent. No bypass possible.

import type {
  SanitizedContext,
  PrivacyGateDecision,
  PIIDetection,
  DetectedElement,
  SanitizedElement,
  BoundingBox,
} from '../types';
import { redactText, verifyPayloadSafety, detectPIIInText } from './pii-detector';

const GATE_VERSION = '1.0' as const;

/**
 * Sanitize the page text, removing all PII patterns.
 * Returns the sanitized text and a list of detections.
 */
export function sanitizeText(rawText: string): { sanitized: string; detections: PIIDetection[] } {
  const detections = detectPIIInText(rawText);
  const sanitized = redactText(rawText);
  return { sanitized, detections };
}

/**
 * Sanitize a list of detected elements:
 * - Strip labels that contain or match sensitive categories
 * - Replace sensitive values with [REDACTED:category]
 */
export function sanitizeElements(elements: DetectedElement[]): {
  sanitized: SanitizedElement[];
  detections: PIIDetection[];
} {
  const detections: PIIDetection[] = [];
  const sanitized: SanitizedElement[] = elements.map(el => {
    if (el.isSensitive && el.sensitiveCategory) {
      detections.push({
        category: el.sensitiveCategory,
        confidence: el.confidence,
        method: 'dom_type',
        location: 'dom',
        masked: true,
        elementId: el.id,
        bbox: el.bbox,
      });
      return {
        id: el.id,
        type: el.type,
        label: `[REDACTED:${el.sensitiveCategory.toUpperCase()}]`,
        isInteractive: el.isInteractive,
        isSensitiveRedacted: true,
        bbox: el.bbox,
      };
    }
    // Also check label text for PII
    const labelDetections = detectPIIInText(el.label);
    const sanitizedLabel = labelDetections.length > 0 ? redactText(el.label) : el.label;
    for (const d of labelDetections) {
      d.elementId = el.id;
      detections.push(d);
    }
    return {
      id: el.id,
      type: el.type,
      label: sanitizedLabel,
      isInteractive: el.isInteractive,
      isSensitiveRedacted: labelDetections.length > 0,
      bbox: el.bbox,
    };
  });
  return { sanitized, detections };
}

/**
 * THE OUTBOUND PRIVACY GATE.
 *
 * Call this EXACTLY ONCE before any external network transmission.
 * It builds and verifies the SanitizedContext.
 * If verification fails, it returns a BLOCKED decision and throws.
 *
 * ⚠️  This function is the SOLE authority on whether data leaves the device.
 *     The planner CANNOT override this decision.
 */
export function runPrivacyGate(
  rawText: string,
  elements: DetectedElement[],
  redactedRegions: BoundingBox[],
): SanitizedContext {
  // Step 1: Sanitize text
  const { sanitized: sanitizedText, detections: textDetections } = sanitizeText(rawText);

  // Step 2: Sanitize elements
  const { sanitized: sanitizedElements, detections: elementDetections } = sanitizeElements(elements);

  // Step 3: Merge all detections
  const allDetections: PIIDetection[] = [...textDetections, ...elementDetections];

  // Step 4: Build provisional payload for verification
  const provisionalPayload = JSON.stringify({ sanitizedText, sanitizedElements });

  // Step 5: Verify the payload has no residual PII
  const { safe, violations } = verifyPayloadSafety(provisionalPayload);

  const blockedCategories = violations.map(v => v.category);

  if (!safe) {
    const decision: PrivacyGateDecision = {
      allowed: false,
      reason: `Privacy gate BLOCKED: Residual PII detected in sanitized payload. Categories: ${blockedCategories.join(', ')}. Transmission prevented.`,
      detectionsCount: allDetections.length,
      blockedCategories,
      sanitizedPayloadSize: 0,
      timestamp: Date.now(),
      gateVersion: GATE_VERSION,
    };

    // Return a blocked context – callers must check privacyGateDecision.allowed
    return {
      sanitizedText: '[TRANSMISSION BLOCKED BY PRIVACY GATE]',
      sanitizedElements: [],
      redactedRegions,
      privacyGateDecision: decision,
      detections: allDetections,
    };
  }

  const decision: PrivacyGateDecision = {
    allowed: true,
    reason: `Privacy gate ALLOWED: ${allDetections.length} item(s) detected and masked. Payload verified clean.`,
    detectionsCount: allDetections.length,
    blockedCategories: [],
    sanitizedPayloadSize: provisionalPayload.length,
    timestamp: Date.now(),
    gateVersion: GATE_VERSION,
  };

  return {
    sanitizedText,
    sanitizedElements,
    redactedRegions,
    privacyGateDecision: decision,
    detections: allDetections,
  };
}

/**
 * Quick check: should a given URL be allowed as a navigation target?
 * Blocks javascript:, data:, about:, and extension-internal URLs.
 */
export function isNavigationAllowed(url: string): { allowed: boolean; reason: string } {
  const trimmed = url.trim().toLowerCase();

  if (trimmed.startsWith('javascript:')) {
    return { allowed: false, reason: 'javascript: URLs are blocked for security.' };
  }
  if (trimmed.startsWith('data:')) {
    return { allowed: false, reason: 'data: URLs are blocked for security.' };
  }
  if (trimmed.startsWith('about:')) {
    return { allowed: false, reason: 'about: URLs are blocked.' };
  }
  if (trimmed.startsWith('chrome-extension:') || trimmed.startsWith('moz-extension:')) {
    return { allowed: false, reason: 'Extension-internal URLs cannot be navigated to.' };
  }
  return { allowed: true, reason: 'URL passed safety check.' };
}
