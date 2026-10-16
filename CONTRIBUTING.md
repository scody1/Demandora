# Contributing to Demandora

Thank you for your interest in contributing to **Demandora — AI-Powered Demand & Supply Intelligence Platform**!

Demandora is built for enterprise-grade supply chain forecasting, demand segmentation, and material requirements planning (MRP). To preserve computational reliability and numerical integrity across releases, please follow these guidelines.

---

## 1. Development Environment Setup

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Python**: v3.10 to v3.12 (virtual environment recommended)

### Clone & Install

```bash
# Clone the repository
git clone https://github.com/your-username/demandora.git
cd demandora

# Install frontend dependencies
npm install

# Set up Python backend virtual environment
python -m venv .venv

# Activate virtual environment
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# Linux / macOS:
source .venv/bin/activate

# Install backend dependencies
pip install -r backend/requirements.txt
```

---

## 2. Running Local Services

### Start the FastAPI Python ML Engine:
```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

### Start the React / Vite Frontend:
```bash
npm run dev
```

The application will be accessible at `http://localhost:3000`.

---

## 3. Testing & Quality Assurance

Before opening a pull request, ensure all test suites pass without regression:

### Frontend Unit & Integration Tests:
```bash
# Run Vitest test suite (201+ tests)
npm test

# Run TypeScript static type verification
npx tsc --noEmit
```

### Backend Forecasting & Cache Tests:
```bash
# Run Pytest suite (190+ tests)
pytest backend/tests
```

### Production Build Validation:
```bash
npm run build
```

---

## 4. Architecture & Engineering Principles

1. **Numerical Parity**: Do not alter statistical model mathematics, walk-forward validation splits, or evaluation metrics without explicit mathematical proofs and test updates.
2. **Zero Temporal Leakage**: All walk-forward cross-validation windows must train strictly on historical intervals `[0 : t]` and evaluate strictly on forward validation splits `[t : t+h]`.
3. **Multi-Layer Cache Preservation**: Ensure the 5-layer persistent SQLite cache schema remains backward compatible. Never rename table columns or invalid cache keys without safe migration logic.
4. **Clean Code & Commits**: Write descriptive commit messages using Conventional Commits (e.g., `feat:`, `fix:`, `perf:`, `docs:`, `refactor:`).
