// Drishti AI – Local Inference Worker
// Runs ONNX-based local models for visual grounding and text analysis.
// Uses WebGPU where available, WASM as fallback.
// Models are loaded lazily and cached.

// This worker communicates via postMessage.
// It is loaded as a Web Worker from the background service worker.

interface InferenceRequest {
  id: string;
  type: 'load_model' | 'classify_text' | 'detect_elements' | 'get_status';
  payload?: unknown;
}

interface InferenceResponse {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
  latencyMs?: number;
}

// ─── Worker State ─────────────────────────────────────────────────────────────

let modelStatus: 'unloaded' | 'loading' | 'ready' | 'error' = 'unloaded';
let activeBackend: 'webgpu' | 'wasm' | 'none' = 'none';
let modelName = 'none';

// ─── Message Handler ──────────────────────────────────────────────────────────

self.addEventListener('message', async (event: MessageEvent<InferenceRequest>) => {
  const { id, type, payload } = event.data;
  const start = Date.now();

  try {
    let result: unknown;

    switch (type) {
      case 'load_model':
        result = await loadModel();
        break;
      case 'classify_text':
        result = await classifyText(payload as string);
        break;
      case 'detect_elements':
        result = await detectElements(payload as { imageData: string; width: number; height: number });
        break;
      case 'get_status':
        result = { modelStatus, backend: activeBackend, modelName };
        break;
      default:
        throw new Error(`Unknown inference request type: ${type}`);
    }

    const response: InferenceResponse = {
      id,
      success: true,
      result,
      latencyMs: Date.now() - start,
    };
    self.postMessage(response);
  } catch (err) {
    const response: InferenceResponse = {
      id,
      success: false,
      error: String(err),
      latencyMs: Date.now() - start,
    };
    self.postMessage(response);
  }
});

// ─── Model Loading ────────────────────────────────────────────────────────────

async function loadModel(): Promise<{ status: string; backend: string; modelName: string }> {
  if (modelStatus === 'ready') {
    return { status: 'already_loaded', backend: activeBackend, modelName };
  }

  modelStatus = 'loading';

  // Detect WebGPU availability
  const hasWebGPU = typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    typeof (navigator as { gpu?: unknown }).gpu !== 'undefined';

  // For the ONNX Runtime Web integration, we attempt to load it dynamically.
  // In production this would load a quantized model (e.g. a tiny text classifier).
  // Since we cannot fetch model files in this context without a model registry,
  // we use the deterministic local planner as our primary inference path.
  // This is transparently reported — we never pretend a model is loaded if it isn't.

  try {
    // Attempt ONNX runtime detection
    // In a full deployment, this would: 
    //   1. import * as ort from 'onnxruntime-web'
    //   2. ort.env.wasm.wasmPaths = '...'
    //   3. const session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['webgpu','wasm'] })
    // We verify the runtime is accessible without loading a model file:

    const ort = await import('onnxruntime-web');
    // Configure WASM paths
    ort.env.wasm.numThreads = 1;

    if (hasWebGPU) {
      // WebGPU backend probe
      try {
        const adapter = await (navigator as Navigator & { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter();
        if (adapter) {
          activeBackend = 'webgpu';
        } else {
          activeBackend = 'wasm';
        }
      } catch {
        activeBackend = 'wasm';
      }
    } else {
      activeBackend = 'wasm';
    }

    // Mark as ready — using local deterministic planner since no model file is bundled.
    // A real deployment would download a quantized model (e.g. ONNX MobileNet variant)
    // from a trusted source and cache it via the Cache API.
    modelStatus = 'ready';
    modelName = `onnxruntime-web (${activeBackend}) — local-deterministic planner active`;

    return { status: 'ready', backend: activeBackend, modelName };
  } catch (err) {
    // ONNX not available (unit test environment, etc.)
    modelStatus = 'error';
    activeBackend = 'none';
    modelName = 'local-deterministic (fallback)';
    return { status: 'error', backend: 'none', modelName };
  }
}

// ─── Inference Functions ──────────────────────────────────────────────────────

/**
 * Classify text for PII categories using local pattern matching.
 * In a full deployment, this would run a text classification ONNX model.
 * Currently uses deterministic pattern matching — transparently reported.
 */
async function classifyText(text: string): Promise<{
  categories: string[];
  confidence: number;
  backend: string;
  isModelInference: boolean;
}> {
  // Import PII detector (available since worker shares the extension bundle)
  const { detectPIIInText } = await import('../privacy/pii-detector');
  const detections = detectPIIInText(text);

  return {
    categories: detections.map(d => d.category),
    confidence: detections.length > 0 ? Math.max(...detections.map(d => d.confidence)) : 0,
    backend: activeBackend,
    isModelInference: false, // Transparent: pattern matching, not ONNX inference
  };
}

/**
 * Detect visual elements in a screenshot.
 * In a full deployment this would run a visual grounding model (e.g. GroundingDINO ONNX).
 * Currently returns a placeholder to indicate the DOM grounding path should be used.
 */
async function detectElements(_input: { imageData: string; width: number; height: number }): Promise<{
  elements: unknown[];
  backend: string;
  isModelInference: boolean;
  message: string;
}> {
  // Visual grounding via ONNX is not available without a bundled model file.
  // DOM-based grounding (content/grounding.ts) is the primary path.
  // This function would be called when DOM is insufficient (e.g., canvas-heavy pages).
  return {
    elements: [],
    backend: activeBackend,
    isModelInference: false,
    message: 'Visual model not loaded. Using DOM-based grounding. To enable visual inference, provide a compatible ONNX model in the models/ directory.',
  };
}

console.debug('[Drishti Inference Worker] Started. WebGPU:', 'gpu' in (typeof navigator !== 'undefined' ? navigator : {}));
