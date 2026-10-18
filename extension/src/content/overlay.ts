// Drishti AI – Visual Overlay
// Draws numbered bounding boxes over detected elements with confidence scores.
// Runs entirely inside the content script context.

import type { DetectedElement } from '../types';

const OVERLAY_ID = 'drishti-overlay-root';
const TOOLTIP_ID = 'drishti-tooltip';

const COLORS: Record<DetectedElement['type'], string> = {
  button:   '#00d4ff',
  link:     '#7c5cd8',
  input:    '#ff9900',
  select:   '#ff9900',
  textarea: '#ff9900',
  checkbox: '#ff9900',
  radio:    '#ff9900',
  heading:  '#22dd55',
  form:     '#ffcc00',
  image:    '#aa88ff',
  text:     '#aaaaaa',
  other:    '#888888',
};

const SENSITIVE_COLOR = '#ff4040';

function getColor(el: DetectedElement): string {
  if (el.isSensitive) return SENSITIVE_COLOR;
  return COLORS[el.type] ?? '#ffffff';
}

function createOverlayRoot(doc: Document): HTMLElement {
  let root = doc.getElementById(OVERLAY_ID);
  if (root) return root;

  root = doc.createElement('div');
  root.id = OVERLAY_ID;
  root.setAttribute('aria-hidden', 'true');
  Object.assign(root.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  doc.body.appendChild(root);
  return root;
}

function createTooltip(doc: Document): HTMLElement {
  let tip = doc.getElementById(TOOLTIP_ID);
  if (tip) return tip;

  tip = doc.createElement('div');
  tip.id = TOOLTIP_ID;
  Object.assign(tip.style, {
    position: 'fixed',
    background: 'rgba(10,20,40,0.95)',
    color: '#e0eaff',
    border: '1px solid #00d4ff',
    borderRadius: '4px',
    padding: '6px 10px',
    fontSize: '12px',
    fontFamily: 'monospace',
    zIndex: '2147483648',
    pointerEvents: 'none',
    display: 'none',
    maxWidth: '300px',
    lineHeight: '1.5',
  });
  doc.body.appendChild(tip);
  return tip;
}

export function showOverlay(elements: DetectedElement[], doc: Document = document): void {
  clearOverlay(doc);
  const root = createOverlayRoot(doc);
  const tooltip = createTooltip(doc);

  elements.forEach((el, idx) => {
    const { x, y, width, height } = el.bbox;
    const color = getColor(el);

    // Bounding box
    const box = doc.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
      border: `2px solid ${color}`,
      boxSizing: 'border-box',
      pointerEvents: 'auto',
      cursor: 'default',
    });

    // Sensitive elements get an opaque privacy mask
    if (el.isSensitive) {
      Object.assign(box.style, {
        background: 'rgba(255,64,64,0.35)',
        backdropFilter: 'blur(0px)',
      });
    }

    // Number badge
    const badge = doc.createElement('span');
    badge.textContent = String(idx + 1);
    Object.assign(badge.style, {
      position: 'absolute',
      top: '-1px',
      left: '-1px',
      background: color,
      color: el.isSensitive ? '#fff' : '#0a1428',
      fontSize: '10px',
      fontFamily: 'monospace',
      fontWeight: 'bold',
      padding: '1px 4px',
      borderRadius: '2px',
      lineHeight: '1.4',
      userSelect: 'none',
    });
    box.appendChild(badge);

    // Confidence
    const confBadge = doc.createElement('span');
    confBadge.textContent = `${Math.round(el.confidence * 100)}%`;
    Object.assign(confBadge.style, {
      position: 'absolute',
      bottom: '-1px',
      right: '-1px',
      background: 'rgba(10,20,40,0.85)',
      color: color,
      fontSize: '9px',
      fontFamily: 'monospace',
      padding: '1px 3px',
      borderRadius: '2px',
      lineHeight: '1.4',
    });
    box.appendChild(confBadge);

    // Hover tooltip
    box.addEventListener('mouseenter', (e: MouseEvent) => {
      const sensitive = el.isSensitive ? `⚠ SENSITIVE: ${el.sensitiveCategory}` : '';
      tooltip.innerHTML = `
        <b>#${idx + 1} ${el.type.toUpperCase()}</b><br>
        Label: ${escapeHtml(el.label)}<br>
        Confidence: ${Math.round(el.confidence * 100)}%<br>
        Source: ${el.source}<br>
        ${sensitive ? `<span style="color:#ff6060">${escapeHtml(sensitive)}</span>` : ''}
      `.trim();
      tooltip.style.display = 'block';
      tooltip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 310)}px`;
      tooltip.style.top = `${Math.min(e.clientY + 12, window.innerHeight - 100)}px`;
    });

    box.addEventListener('mousemove', (e: MouseEvent) => {
      tooltip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 310)}px`;
      tooltip.style.top = `${Math.min(e.clientY + 12, window.innerHeight - 100)}px`;
    });

    box.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });

    root.appendChild(box);
  });
}

export function clearOverlay(doc: Document = document): void {
  const root = doc.getElementById(OVERLAY_ID);
  if (root) root.remove();
  const tooltip = doc.getElementById(TOOLTIP_ID);
  if (tooltip) tooltip.remove();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Draw opaque redaction masks over sensitive regions (for screenshot preview).
 * These are solid black boxes — not CSS blur.
 */
export function drawRedactionMasks(
  canvas: HTMLCanvasElement,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#000000';
  for (const r of regions) {
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }
}
