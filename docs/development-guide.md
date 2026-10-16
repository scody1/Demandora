# Demandora Development & Testing Guide

This guide details setup, local development workflows, code quality guidelines, and testing procedures for the Demandora platform.

---

## 1. Prerequisites

- **Node.js**: v18.0.0 or higher (v20.x recommended)
- **npm**: v9.0.0 or higher
- **Python**: v3.10 to v3.12 (Python 3.12 recommended)
- **Git**: v2.30 or higher

---

## 2. Local Setup

### Step 1: Clone Repository
```bash
git clone https://github.com/scody1/Demandora.git
cd Demandora
```

### Step 2: Configure Environment
```bash
cp .env.example .env
```
Key configuration parameters:
- `PORT=8000`: FastAPI ML engine listening port.
- `HOST=127.0.0.1`: Localhost binding.
- `DEMANDORA_WORKERS=8`: Concurrency threads for backtesting.
- `VITE_API_URL=http://localhost:8000`: Frontend backend bridge URL.

### Step 3: Backend Virtual Environment & Dependencies
```bash
python -m venv .venv

# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# Linux / macOS:
source .venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt
```

### Step 4: Frontend Dependencies
```bash
npm install
```

---

## 3. Running Services

### One-Click Launch (Windows)
Run `start.bat` to launch both the FastAPI backend (port 8000) and the Vite frontend (port 3000) in separate terminals and open your default browser. To stop all services, run `stop.bat`.

### Manual Service Launch

**Terminal 1 (Backend ML Engine):**
```bash
.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

**Terminal 2 (Frontend Client):**
```bash
npm run dev
```

---

## 4. Running the Test Suites

Demandora enforces automated test coverage across both backend and frontend.

### Backend Python Suite (190 Tests)
```bash
pytest backend/tests -v
```
Validates:
- Mathematical accuracy of candidate models (`models.py`)
- Zero temporal data leakage in chronological backtesting (`backtesting.py`)
- SQLite 5-layer cache persistence and hash collision avoidance (`cache.py`)
- Demand segmentation rules (`segmentation.py`)
- Procurement guardrails and safety stock limits (`heuristics.py`)

### Frontend TypeScript Suite (201 Tests)
```bash
npm test
```
Validates:
- Excel ingestion and column alias fuzzy mapping (`excelService.ts`)
- Gross-to-net MRP calculations and MOQ rounding (`mrpCalculation.test.ts`)
- Multi-tier BOM recursive explosions (`fsd.test.ts`)
- Forecast Grid rendering, column alignment, and horizontal scrolling (`ForecastGrid.layout.test.tsx`)
- Version history snapshot immutability (`phase9.test.ts`)

### Static Type Verification
```bash
npx tsc --noEmit
```

### Production Build Validation
```bash
npm run build
```
Creates an optimized production bundle in the `dist/` directory.
