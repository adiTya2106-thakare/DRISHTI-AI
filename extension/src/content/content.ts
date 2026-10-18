// Drishti AI – Content Script
// Injected into every page. Handles DOM inspection, overlay display,
// and safe browser action execution.

import { groundElements, recheckElement, findElementByText } from './grounding';
import { showOverlay, clearOverlay } from './overlay';
import { scanDOMForSensitiveFields } from '../privacy/pii-detector';
import type { ExtensionMessage, AgentAction, ActionResult, PageState, DetectedElement } from '../types';

// ─── State ────────────────────────────────────────────────────────────────────

let currentElements: DetectedElement[] = [];
let overlayVisible = false;

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch(err => {
      sendResponse({ error: String(err) });
    });
    return true; // keep channel open for async
  }
);

async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  switch (message.type) {
    case 'INSPECT_PAGE': {
      return await inspectPage();
    }
    case 'OVERLAY_SHOW': {
      const elements = message.payload.elements;
      currentElements = elements;
      showOverlay(elements, document);
      overlayVisible = true;
      return { ok: true };
    }
    case 'OVERLAY_HIDE': {
      clearOverlay(document);
      overlayVisible = false;
      return { ok: true };
    }
    case 'EXECUTE_ACTION': {
      return await executeAction(message.payload);
    }
    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

// ─── Page Inspection ──────────────────────────────────────────────────────────

async function inspectPage(): Promise<PageState> {
  const elements = groundElements(document);
  currentElements = elements;

  // Collect page text (NEVER raw input values — only visible text content)
  const pageText = extractVisibleText(document);

  // Scan for sensitive DOM fields (adds isSensitive flags to elements in-place)
  const domDetections = scanDOMForSensitiveFields(document);

  // Mark elements as sensitive based on DOM scan
  const sensitiveCount = domDetections.length;
  console.debug(`[Drishti] Inspected page: ${elements.length} elements, ${sensitiveCount} sensitive fields`);

  return {
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    elements,
    pageText,
    // No screenshot here — screenshots are taken by background SW with redaction
  };
}

function extractVisibleText(doc: Document): string {
  // Walk text nodes, skip scripts/styles/hidden
  const skipTags = new Set(['script', 'style', 'noscript', 'head', 'svg', 'iframe']);
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (skipTags.has(parent.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      // Never capture input values — they could contain passwords or PII
      if (['input', 'textarea'].includes(parent.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const texts: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.textContent ?? '').trim();
    if (text.length > 1) texts.push(text);
  }

  return texts.join(' ').slice(0, 8000); // limit for privacy and token budget
}

// ─── Action Execution ─────────────────────────────────────────────────────────

const CONSEQUENTIAL_ACTIONS = new Set<AgentAction['type']>([
  'NAVIGATE', // if it posts a form / external
]);

async function executeAction(action: AgentAction): Promise<ActionResult> {
  const start = Date.now();

  try {
    switch (action.type) {
      case 'INSPECT': {
        const state = await inspectPage();
        return { success: true, message: 'Page inspected.', newState: state };
      }

      case 'CLICK': {
        const el = resolveElement(action);
        if (!el) return { success: false, error: `Element not found: ${action.selector ?? action.elementId}`, retryable: true };

        // Recheck position before clicking
        if (action.selector) {
          const expectedBbox = currentElements.find(e => e.selector === action.selector)?.bbox;
          if (expectedBbox) {
            const check = recheckElement(action.selector, expectedBbox, document);
            if (!check.valid) {
              return { success: false, error: `Stale element: ${check.reason}`, retryable: true };
            }
          }
        }

        (el as HTMLElement).click();
        await sleep(300);
        return { success: true, message: `Clicked ${action.selector ?? action.elementId}` };
      }

      case 'TYPE': {
        const el = resolveElement(action) as HTMLInputElement | null;
        if (!el) return { success: false, error: `Element not found for TYPE`, retryable: true };

        // Safety: never type into password fields via AI command
        const inputType = el.getAttribute('type')?.toLowerCase();
        if (inputType === 'password') {
          return { success: false, error: 'Typing into password fields is not permitted.', retryable: false };
        }

        el.focus();
        el.value = action.value ?? '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(100);
        return { success: true, message: `Typed into ${action.selector}` };
      }

      case 'SELECT': {
        const sel = resolveElement(action) as HTMLSelectElement | null;
        if (!sel || sel.tagName.toLowerCase() !== 'select') {
          return { success: false, error: 'SELECT target is not a <select> element.', retryable: false };
        }
        sel.value = action.value ?? '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, message: `Selected '${action.value}' in ${action.selector}` };
      }

      case 'SCROLL': {
        const pixels = action.pixels ?? 300;
        const dir = action.direction ?? 'down';
        const dy = dir === 'down' ? pixels : dir === 'up' ? -pixels : 0;
        const dx = dir === 'right' ? pixels : dir === 'left' ? -pixels : 0;
        window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
        await sleep(400);
        return { success: true, message: `Scrolled ${dir} ${pixels}px` };
      }

      case 'WAIT': {
        await sleep(Math.min(action.pixels ?? 1000, 5000));
        return { success: true, message: 'Wait completed.' };
      }

      case 'ASK_USER': {
        // Relay to background for popup notification
        return { success: true, message: action.message ?? 'User input required.' };
      }

      case 'NAVIGATE': {
        // Navigation is handled by background SW, not content script
        return { success: true, message: `Navigation request forwarded.` };
      }

      case 'DONE': {
        clearOverlay(document);
        return { success: true, message: action.reason ?? 'Task completed.' };
      }

      default:
        return { success: false, error: `Unknown action type: ${(action as AgentAction).type}`, retryable: false };
    }
  } catch (err) {
    return { success: false, error: String(err), retryable: true };
  }
}

function resolveElement(action: AgentAction): Element | null {
  if (action.selector) {
    try {
      return document.querySelector(action.selector);
    } catch {
      return null;
    }
  }
  if (action.elementId) {
    // Find by drishti ID in our current elements cache
    const cached = currentElements.find(e => e.id === action.elementId);
    if (cached) {
      try {
        return document.querySelector(cached.selector);
      } catch {
        return null;
      }
    }
  }
  if (action.value) {
    return findElementByText(action.value, document);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.debug('[Drishti AI] Content script loaded on', window.location.hostname);
