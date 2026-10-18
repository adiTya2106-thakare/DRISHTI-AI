// Drishti AI – Visual Grounding Engine (DOM-based)
// Identifies and maps interactive/important elements, assigns stable IDs,
// computes bounding boxes, and classifies element types.

import type { DetectedElement, BoundingBox } from '../types';
import { classifyInputElement, findLabelText, classifyByLabel } from '../privacy/pii-detector';

let _idCounter = 0;

function makeId(prefix: string): string {
  return `drishti-${prefix}-${Date.now()}-${_idCounter++}`;
}

function getBBox(el: Element): BoundingBox | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    x: Math.round(rect.left + window.scrollX),
    y: Math.round(rect.top + window.scrollY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getElementType(el: Element): DetectedElement['type'] {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase() ?? '';

  if (tag === 'button' || type === 'button' || type === 'submit' || type === 'reset') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (tag === 'input') return 'input';
  if (['h1','h2','h3','h4','h5','h6'].includes(tag)) return 'heading';
  if (tag === 'form') return 'form';
  if (tag === 'img') return 'image';
  if (el.getAttribute('role') === 'button') return 'button';
  if (el.getAttribute('role') === 'link') return 'link';
  return 'other';
}

function buildSelector(el: Element): string {
  const id = el.getAttribute('id');
  if (id) return `#${CSS.escape(id)}`;

  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute('name');
  if (name) return `${tag}[name="${name}"]`;

  const cls = Array.from(el.classList)
    .filter(c => c && !c.startsWith('ng-') && !c.includes('--'))
    .slice(0, 2)
    .join('.');
  if (cls) return `${tag}.${cls}`;

  return tag;
}

function getLabel(el: Element, doc: Document): string {
  // Try label first
  const labelText = findLabelText(el, doc);
  if (labelText && labelText.length > 0) return labelText.slice(0, 80);

  // aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.slice(0, 80);

  // text content for buttons/links
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'h1' || tag === 'h2' || tag === 'h3') {
    const text = (el.textContent ?? '').trim().slice(0, 80);
    if (text) return text;
  }

  // placeholder
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder.slice(0, 80);

  // alt text for images
  if (tag === 'img') {
    return el.getAttribute('alt') ?? 'image';
  }

  // value for buttons
  const value = (el as HTMLInputElement).value;
  if (value) return value.slice(0, 80);

  return tag;
}

/**
 * Main grounding function.
 * Scans the document for all interactive and important elements,
 * returns a list of DetectedElement with stable IDs and bounding boxes.
 */
export function groundElements(doc: Document = document): DetectedElement[] {
  const INTERACTIVE_SELECTORS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="menuitem"]',
    '[role="tab"]',
    'h1', 'h2', 'h3',
    'form',
  ].join(', ');

  const elements: DetectedElement[] = [];
  const seen = new Set<Element>();

  doc.querySelectorAll(INTERACTIVE_SELECTORS).forEach(el => {
    if (seen.has(el)) return;
    if (!isVisible(el)) return;
    seen.add(el);

    const bbox = getBBox(el);
    if (!bbox) return;

    const elType = getElementType(el);
    const label = getLabel(el, doc);
    const selector = buildSelector(el);

    // PII check
    const piiDetection = classifyInputElement(el);
    const labelPii = !piiDetection ? classifyByLabel(label) : null;
    const effectivePii = piiDetection ?? labelPii;

    elements.push({
      id: makeId(elType),
      type: elType,
      label,
      selector,
      bbox,
      confidence: elType === 'other' ? 0.7 : 0.92,
      source: 'dom',
      isSensitive: !!effectivePii,
      sensitiveCategory: effectivePii?.category,
      isInteractive: ['button','link','input','select','textarea','checkbox','radio'].includes(elType),
      tagName: el.tagName.toLowerCase(),
      attributes: getRelevantAttributes(el),
    });
  });

  return elements;
}

function getRelevantAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  const relevant = ['type', 'name', 'id', 'class', 'href', 'role', 'disabled', 'required', 'aria-label', 'placeholder'];
  for (const attr of relevant) {
    const val = el.getAttribute(attr);
    if (val !== null) attrs[attr] = val.slice(0, 200);
  }
  return attrs;
}

/**
 * Re-check that an element is still in the DOM and at the expected position.
 * Returns true if the element is still valid, false if it has moved/changed significantly.
 */
export function recheckElement(selector: string, expectedBbox: BoundingBox, doc: Document = document): {
  valid: boolean;
  currentBbox?: BoundingBox;
  reason?: string;
} {
  try {
    const el = doc.querySelector(selector);
    if (!el) return { valid: false, reason: `Element '${selector}' no longer exists in DOM.` };

    const currentBbox = getBBox(el);
    if (!currentBbox) return { valid: false, reason: `Element '${selector}' is no longer visible.` };

    // Allow 40px tolerance for scroll/reflow
    const tolerance = 40;
    const moved =
      Math.abs(currentBbox.x - expectedBbox.x) > tolerance ||
      Math.abs(currentBbox.y - expectedBbox.y) > tolerance;

    if (moved) {
      return { valid: false, currentBbox, reason: `Element has moved significantly (expected ~(${expectedBbox.x},${expectedBbox.y}), found (${currentBbox.x},${currentBbox.y})).` };
    }

    return { valid: true, currentBbox };
  } catch {
    return { valid: false, reason: 'DOM query failed.' };
  }
}

/**
 * Find the closest visible element containing the given text.
 */
export function findElementByText(text: string, doc: Document = document): Element | null {
  const lower = text.toLowerCase();
  const candidates = doc.querySelectorAll('button, a, input, label, h1, h2, h3, p, span, td, li');
  for (const el of Array.from(candidates)) {
    if ((el.textContent ?? '').toLowerCase().includes(lower) && isVisible(el)) {
      return el;
    }
  }
  return null;
}
