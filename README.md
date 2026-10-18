# 👁 Drishti AI — Privacy-First On-Device Visual Browser Agent

> **Privacy-first** browser automation agent. All PII is detected and redacted **before** leaving the device. No raw user data ever reaches the backend.

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Chrome Extension (TypeScript + React)                   │
│  ┌─────────────┐  ┌───────────────┐  ┌───────────────┐  │
│  │ Content     │  │ Background SW │  │  Popup /      │  │
│  │ Script      │  │ (task runner) │  │  Dashboard    │  │
│  │ grounding   │  │ privacy gate  │  │  (React UI)   │  │
│  │ overlay     │  │ ledger (IDB)  │  │               │  │
│  └─────────────┘  └───────┬───────┘  └───────────────┘  │
└──────────────────────────┼──────────────────────────────┘
                           │ Sanitized context only
                           ▼
┌─────────────────────────────────────────────────────────┐
│  FastAPI Backend (Python)  — http://localhost:8000       │
│  /api/health  /api/tasks/plan  /api/privacy/events       │
│  /api/performance  /api/benchmark/run  /ws/{session}     │
│  SQLite (aiosqlite)  •  WebSocket live updates           │
└─────────────────────────────────────────────────────────┘
```

---

## ✨ Features

| Feature | Detail |
|---|---|
| **Privacy Gate** | 15-category PII detector; blocks transmission if residual PII found |
| **DOM Grounding** | Detects & annotates all interactive elements with bounding boxes |
| **Visual Overlay** | Numbered bounding boxes with confidence scores on every page |
| **Task Planning** | Local deterministic planner (offline) + optional OpenAI / Anthropic |
| **Privacy Ledger** | Tamper-evident log in IndexedDB — every gate decision recorded |
| **Attack Lab** | Synthetic PII benchmark — real F1/precision/recall, no fabricated numbers |
| **Dashboard** | Full mission control: elements, firewall, history, monitor, settings |
| **WebSocket** | Live backend push events to dashboard |

---

## 🚀 Quick Start

### 1 — Backend

```bash
# From repo root
cd backend
python -m venv .venv           # or use the existing .venv at root
.venv\Scripts\activate         # Windows
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Backend runs at **http://localhost:8000**  
API docs at **http://localhost:8000/docs**

#### Optional LLM planning
Copy `.env.example` → `.env` and add a key:
```
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
```
Leave blank for offline deterministic planning.

---

### 2 — Extension (build)

```bash
cd extension
npm install
npm run build        # output → extension/dist/
```

#### Load in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/dist/`
4. The Drishti AI icon appears in your toolbar

---

### 3 — Use It

1. Start the backend (step 1)
2. Load the extension (step 2)
3. Navigate to any webpage
4. Click the **D** toolbar icon
5. Type a task — e.g. *"Find the application deadline and click the apply button"*
6. Hit **▶ Run Task**
7. Open **Full Dashboard** for the complete mission control view

---

## 🧪 Tests

### Backend (35 tests)
```bash
cd backend
..\.venv\Scripts\python.exe -m pytest tests/ -v
```

### Extension (75 tests)
```bash
cd extension
npm test
```

---

## 📁 Project Structure

```
DRISHTI-AI/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, CORS, WebSocket
│   │   ├── routers/             # health, plan, tasks, privacy_events,
│   │   │                        # performance, benchmark, system_status
│   │   ├── services/
│   │   │   ├── planner.py       # local + OpenAI + Anthropic planners
│   │   │   └── ws_manager.py    # WebSocket connection manager
│   │   ├── models/schemas.py    # Pydantic schemas (strict validation)
│   │   └── db/database.py       # aiosqlite, 4 tables
│   ├── tests/                   # 35 API tests
│   └── requirements.txt
│
├── extension/
│   ├── src/
│   │   ├── background/background.ts   # Service worker, task runner
│   │   ├── content/
│   │   │   ├── content.ts             # DOM actions executor
│   │   │   ├── grounding.ts           # Element detection + bounding boxes
│   │   │   └── overlay.ts             # Visual bounding-box overlay
│   │   ├── privacy/
│   │   │   ├── pii-detector.ts        # 15-category regex PII detection
│   │   │   └── privacy-gate.ts        # Outbound transmission gate
│   │   ├── popup/popup.tsx            # Extension popup UI
│   │   ├── dashboard/dashboard.tsx    # Full mission control dashboard
│   │   ├── api/client.ts              # Typed backend API client
│   │   ├── workers/inference-worker.ts # ONNX inference worker
│   │   └── types/index.ts             # Shared TypeScript types
│   ├── tests/                         # 75 unit tests
│   ├── public/icons/                  # Extension icons (16/32/48/128px)
│   └── vite.config.ts
│
└── docs/
```

---

## 🔒 Privacy Guarantees

- **No raw input values** are ever read or transmitted
- **Password fields** are blocked from all AI actions
- **PII categories detected**: password, email, phone, Aadhaar, PAN, credit card, account number, SSN, name, address, DOB, IP address, API key, auth token, generic PII
- **Privacy Gate** runs a final verification sweep on the sanitized payload before every network call — if residual PII is found, transmission is **blocked entirely**
- **Server-side defence in depth**: backend re-validates sanitized text for unredacted emails and password fields

---

## 📊 API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Backend health + uptime |
| GET | `/api/system/status` | Planner mode, models, capabilities |
| POST | `/api/tasks/plan` | Generate action plan from sanitized context |
| GET | `/api/tasks` | Task history (paginated) |
| POST | `/api/tasks/{id}/events` | Record task execution event |
| DELETE | `/api/tasks` | Clear task history |
| GET | `/api/privacy/events` | Privacy audit log |
| POST | `/api/privacy/events` | Record privacy event |
| GET | `/api/performance` | Latency stats from DB |
| POST | `/api/benchmark/run` | Run synthetic PII benchmark |
| WS | `/ws/{session_id}` | Live WebSocket updates |

---

## 🛠 Tech Stack

**Backend:** Python 3.11+, FastAPI, Pydantic v2, aiosqlite, uvicorn, httpx  
**Extension:** TypeScript, React 18, Vite, ONNX Runtime Web, idb, Zod  
**Tests:** pytest + pytest-asyncio (backend), vitest + jsdom (extension)

---

## 👤 Author

**Aditya Thakare**  
GitHub: [@adiTya2106-thakare](https://github.com/adiTya2106-thakare)

---

*Built for ISRO / IBM — Privacy-First AI Browser Agent*
