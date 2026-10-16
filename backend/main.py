"""
FastAPI Server for Demandora Real Forecasting Engine.

Runs locally on port 8000.
Endpoints:
- GET /health
- GET /api/forecast/models
- POST /api/forecast/predict
- POST /api/forecast/batch
"""

from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict

from .engine import ForecastingEngine
from .llm import generate_explanation
from .segmentation import classify_sku, segment_sku_population, DEFAULT_SEGMENTATION_CONFIG

app = FastAPI(
    title="Demandora — AI-Powered Demand & Supply Intelligence Platform",
    version="1.0.0",
    description="AI-Powered Demand & Supply Intelligence Platform using scikit-learn and statsmodels."
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_cors_and_pna_headers(request, call_next):
    if request.method == "OPTIONS":
        from fastapi.responses import Response
        res = Response(status_code=200)
        res.headers["Access-Control-Allow-Origin"] = request.headers.get("origin", "*")
        res.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH"
        res.headers["Access-Control-Allow-Headers"] = request.headers.get("access-control-request-headers", "*")
        res.headers["Access-Control-Allow-Credentials"] = "true"
        if request.headers.get("access-control-request-private-network") == "true":
            res.headers["Access-Control-Allow-Private-Network"] = "true"
        return res
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

engine = ForecastingEngine()


class SingleSKURequest(BaseModel):
    itemCode: str
    history: List[float]
    description: Optional[str] = ""
    itemGroup: Optional[str] = ""
    periods: Optional[List[str]] = None
    missingPeriods: Optional[List[str]] = None
    horizon: int = Field(default=6, ge=1, le=24)
    startMonth: Optional[str] = "2026-11"
    preferredModel: Optional[str] = None
    candidatePool: Optional[List[Dict[str, Any]]] = None
    isDiscontinued: Optional[bool] = False

    model_config = ConfigDict(coerce_numbers_to_str=True)


class BatchItem(BaseModel):
    itemCode: str
    history: List[float]
    description: Optional[str] = ""
    itemGroup: Optional[str] = ""
    periods: Optional[List[str]] = None
    missingPeriods: Optional[List[str]] = None
    isDiscontinued: Optional[bool] = False

    model_config = ConfigDict(coerce_numbers_to_str=True)


class BatchForecastRequest(BaseModel):
    items: List[BatchItem]
    horizon: int = Field(default=6, ge=1, le=24)
    startMonth: Optional[str] = "2026-11"
    allowedCategories: Optional[List[str]] = None
    candidatePool: Optional[List[BatchItem]] = None
    force: Optional[bool] = False


class SegmentationRequest(BaseModel):
    items: List[BatchItem]
    config: Optional[Dict[str, Any]] = None


class ExplanationRequest(BaseModel):
    itemCode: str
    description: str = ""
    pattern: str = "unknown"
    historyLength: int = 0
    historicalAvg: float = 0.0
    recentDemand: List[float] = []
    fullForecast: List[float] = []
    forecastTotal: float = 0.0
    confidencePct: Optional[float] = None
    predictionInterval: Optional[Dict[str, float]] = None
    intervalMethod: Optional[str] = None
    wape: Optional[float] = None
    mae: Optional[float] = None
    rmse: Optional[float] = None
    bias: Optional[float] = None
    validationWindowCount: Optional[int] = None
    selectedModel: str = "Naive"
    modelType: str = "baseline"
    trendDirection: Optional[str] = None
    trendStrength: Optional[float] = None
    seasonalityDetected: Optional[bool] = None
    seasonalityPeriod: Optional[int] = None
    seasonalityStrength: Optional[float] = None
    outlierCount: Optional[int] = None
    missingPeriods: Optional[int] = None
    zeroDemandRatio: Optional[float] = None
    forecastEligibility: Optional[str] = None
    recommendedModelFamily: Optional[str] = None
    dataQualityFlags: Optional[List[str]] = None
    stock: Optional[float] = None
    openPo: Optional[float] = None
    netReq: Optional[float] = None
    plannerAdj: Optional[float] = None
    finalQuantity: Optional[float] = None
    alerts: List[str] = []


class ExplanationResponse(BaseModel):
    summary: Optional[str] = None
    drivers: Optional[List[str]] = None
    risk: Optional[str] = None
    plannerAttention: Optional[str] = None
    recommendation: Optional[str] = None
    unavailable: Optional[bool] = False
    reason: Optional[str] = None

    model_config = ConfigDict(extra="ignore")  # Strip unknown fields automatically


@app.get("/health")
def health_check():
    return {
        "status": "online",
        "service": "Demandora Python ML Forecasting Service",
        "version": "1.0.0",
        "runtimes": {
            "python": "3.12",
            "scikit_learn": "HistGradientBoostingRegressor",
            "statsmodels": "Holt Exponential Smoothing",
            "numpy": "2.5.2"
        }
    }


@app.get("/api/forecast/models")
def list_models():
    models = engine.get_candidate_models()
    return [
        {
            "name": m.name,
            "type": m.model_type,
            "minHistoryMonths": m.min_history,
            "description": m.__doc__.strip() if m.__doc__ else ""
        }
        for m in models
    ]


@app.post("/api/forecast/predict")
def predict_single(req: SingleSKURequest):
    try:
        return engine.forecast_single_sku(
            item_code=req.itemCode,
            history_values=req.history,
            history_periods=req.periods,
            missing_periods=req.missingPeriods,
            horizon=req.horizon,
            start_month=req.startMonth,
            preferred_model=req.preferredModel,
            description=req.description,
            item_group=req.itemGroup,
            candidate_pool=req.candidatePool,
            is_discontinued=bool(req.isDiscontinued)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


import time
import uuid
import threading

# Thread-safe in-memory job registry for background forecast jobs
jobs: Dict[str, Dict[str, Any]] = {}
job_lock = threading.Lock()

STAGE_ORDER = [
    "Validating Excel demand history",
    "Constructing chronological features",
    "Profiling SKU demand patterns",
    "Training eligible candidate models",
    "Running walk-forward backtesting",
    "Selecting the best-performing model",
    "Refitting selected models on available history",
    "Generating future demand forecasts",
    "Calculating prediction intervals and reliability"
]


def _cleanup_old_jobs():
    """Removes stale or excess completed/failed jobs."""
    now = time.time()
    to_delete = []
    for jid, job in list(jobs.items()):
        if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            if now - job.get("endTime", now) > 3600:
                to_delete.append(jid)
        elif job["status"] in ("QUEUED", "RUNNING"):
            # Auto-cancel stale jobs running longer than 15 minutes
            if now - job.get("startTime", now) > 900:
                job["status"] = "CANCELLED"
                job["cancelled"] = True
                job["endTime"] = now
                job["elapsedSeconds"] = round(now - job.get("startTime", now), 2)
                if hasattr(engine, "cache") and engine.cache:
                    engine.cache.save_job(job)
    for jid in to_delete:
        jobs.pop(jid, None)

    if len(jobs) > 50:
        finished = [
            jid for jid, j in jobs.items()
            if j["status"] in ("COMPLETED", "FAILED", "CANCELLED")
        ]
        finished.sort(key=lambda jid: jobs[jid].get("startTime", 0))
        while len(jobs) > 50 and finished:
            jobs.pop(finished.pop(0), None)


def _run_forecast_job(
    job_id: str,
    items_payload: List[Dict[str, Any]],
    horizon: int,
    start_month: str,
    candidate_pool_payload: Optional[List[Dict[str, Any]]] = None
):
    with job_lock:
        if job_id not in jobs or jobs[job_id]["cancelled"]:
            return
        jobs[job_id]["status"] = "RUNNING"
        jobs[job_id]["startTime"] = time.time()
        jobs[job_id]["currentStage"] = "Profiling SKU demand patterns"
        jobs[job_id]["completedStages"] = [
            "Validating Excel demand history",
            "Constructing chronological features"
        ]
        if hasattr(engine, "cache") and engine.cache:
            engine.cache.telemetry.reset()
            engine.cache.save_job(jobs[job_id])

    total_items = len(items_payload)
    completed_skus = set()

    def progress_callback(event: Dict[str, Any]):
        with job_lock:
            if job_id not in jobs:
                return
            job = jobs[job_id]
            if job["cancelled"]:
                return

            ev_type = event.get("event")
            code = event.get("itemCode")
            model = event.get("modelName")
            stage = event.get("stage")

            if code:
                job["currentItemCode"] = code
            if model:
                job["currentModel"] = model
            if stage:
                job["currentStage"] = stage

            if ev_type == "sku_finished" and code:
                completed_skus.add(code)
                job["completedItems"] = len(completed_skus)
                if total_items > 0:
                    job["progressPercentage"] = round((len(completed_skus) / total_items) * 100, 1)

            if stage and stage in STAGE_ORDER:
                curr_idx = STAGE_ORDER.index(stage)
                for idx in range(curr_idx):
                    st = STAGE_ORDER[idx]
                    if st not in job["completedStages"]:
                        job["completedStages"].append(st)

    try:
        def is_cancelled_check():
            with job_lock:
                return jobs.get(job_id, {}).get("cancelled", False)

        result = engine.forecast_batch(
            items=items_payload,
            horizon=horizon,
            start_month=start_month,
            candidate_pool=candidate_pool_payload,
            progress_callback=progress_callback,
            is_cancelled=is_cancelled_check
        )

        with job_lock:
            if job_id not in jobs:
                return
            job = jobs[job_id]
            if job["cancelled"]:
                job["status"] = "CANCELLED"
                job["endTime"] = time.time()
                job["elapsedSeconds"] = round(job["endTime"] - job["startTime"], 2)
            else:
                job["status"] = "COMPLETED"
                job["currentStage"] = "Calculating MRP and procurement requirements"
                job["completedStages"] = list(STAGE_ORDER)
                job["completedItems"] = total_items
                job["progressPercentage"] = 100.0
                job["result"] = result
                job["telemetry"] = result.get("telemetry")
                job["endTime"] = time.time()
                job["elapsedSeconds"] = round(job["endTime"] - job["startTime"], 2)

            if hasattr(engine, "cache") and engine.cache:
                engine.cache.save_job(job)

    except Exception as e:
        with job_lock:
            if job_id in jobs:
                job = jobs[job_id]
                if job["cancelled"]:
                    job["status"] = "CANCELLED"
                else:
                    job["status"] = "FAILED"
                    job["error"] = str(e)
                job["endTime"] = time.time()
                job["elapsedSeconds"] = round(job["endTime"] - job["startTime"], 2)
                if hasattr(engine, "cache") and engine.cache:
                    engine.cache.save_job(job)


class JobCreatedResponse(BaseModel):
    jobId: str
    status: str


class JobStatusResponse(BaseModel):
    jobId: str
    status: str
    currentStage: str
    completedStages: List[str]
    completedItems: int
    totalItems: int
    currentItemCode: Optional[str] = None
    currentModel: Optional[str] = None
    elapsedSeconds: float
    progressPercentage: Optional[float] = None
    error: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    telemetry: Optional[Dict[str, Any]] = None
    allowedCategories: Optional[List[str]] = None


@app.post("/api/forecast/jobs", response_model=JobCreatedResponse)
def create_forecast_job(req: BatchForecastRequest):
    if not req.items:
        raise HTTPException(status_code=400, detail="Items list cannot be empty.")

    # Independent backend scope validation
    if req.allowedCategories:
        allowed_set = set(cat.strip().upper() for cat in req.allowedCategories)
        invalid_items = []
        for it in req.items:
            cls = classify_sku(it.itemCode, it.history, description=it.description or "", item_group=it.itemGroup or "")
            if cls["category"] not in allowed_set:
                invalid_items.append(f"{it.itemCode} ({cls['category']})")
        if invalid_items:
            raise HTTPException(
                status_code=400,
                detail=f"Scope violation: {len(invalid_items)} item(s) do not belong to requested category scope {req.allowedCategories}: {', '.join(invalid_items[:5])}"
            )

    with job_lock:
        _cleanup_old_jobs()
        # Prevent duplicate jobs if one is actively running or queued
        for jid, job in list(jobs.items()):
            if job["status"] in ("QUEUED", "RUNNING"):
                if getattr(req, "force", False) or (time.time() - job.get("startTime", time.time()) > 600):
                    job["status"] = "CANCELLED"
                    job["cancelled"] = True
                    job["endTime"] = time.time()
                    job["elapsedSeconds"] = round(job["endTime"] - job["startTime"], 2)
                    if hasattr(engine, "cache") and engine.cache:
                        engine.cache.save_job(job)
                else:
                    raise HTTPException(status_code=409, detail=f"A forecast job is already in progress (jobId: {jid}).")

        job_id = f"job_{uuid.uuid4().hex[:12]}"
        job_data = {
            "jobId": job_id,
            "status": "QUEUED",
            "currentStage": "Validating Excel demand history",
            "completedStages": ["Validating Excel demand history"],
            "completedItems": 0,
            "totalItems": len(req.items),
            "currentItemCode": "",
            "currentModel": "",
            "elapsedSeconds": 0.0,
            "progressPercentage": 0.0,
            "error": None,
            "result": None,
            "telemetry": None,
            "allowedCategories": req.allowedCategories,
            "startTime": time.time(),
            "endTime": None,
            "cancelled": False
        }
        jobs[job_id] = job_data
        if hasattr(engine, "cache") and engine.cache:
            engine.cache.save_job(job_data)

    items_payload = [item.model_dump() for item in req.items]
    candidate_pool_payload = (
        [item.model_dump() for item in req.candidatePool]
        if req.candidatePool is not None
        else None
    )
    worker_thread = threading.Thread(
        target=_run_forecast_job,
        args=(job_id, items_payload, req.horizon, req.startMonth, candidate_pool_payload),
        daemon=True
    )
    worker_thread.start()

    return JobCreatedResponse(jobId=job_id, status="QUEUED")


@app.get("/api/forecast/jobs/{job_id}", response_model=JobStatusResponse)
def get_forecast_job(job_id: str):
    with job_lock:
        job = jobs.get(job_id)
        if job is None and hasattr(engine, "cache") and engine.cache:
            cached_job = engine.cache.get_job(job_id)
            if cached_job is not None:
                job = cached_job

        if job is None:
            raise HTTPException(status_code=404, detail="Forecast job not found.")

        if job["status"] in ("QUEUED", "RUNNING"):
            elapsed = time.time() - job["startTime"]
        else:
            elapsed = job.get("elapsedSeconds", 0.0)

        return JobStatusResponse(
            jobId=job["jobId"],
            status=job["status"],
            currentStage=job["currentStage"],
            completedStages=list(job.get("completedStages", [])),
            completedItems=job.get("completedItems", 0),
            totalItems=job.get("totalItems", 0),
            currentItemCode=job.get("currentItemCode") or None,
            currentModel=job.get("currentModel") or None,
            elapsedSeconds=round(elapsed, 2),
            progressPercentage=job.get("progressPercentage"),
            error=job.get("error"),
            result=job.get("result"),
            telemetry=job.get("telemetry") or (job.get("result", {}) or {}).get("telemetry"),
            allowedCategories=job.get("allowedCategories")
        )


@app.post("/api/forecast/jobs/{job_id}/cancel", response_model=JobCreatedResponse)
def cancel_forecast_job(job_id: str):
    with job_lock:
        if job_id not in jobs:
            # Check if it exists in cache
            if hasattr(engine, "cache") and engine.cache:
                cached = engine.cache.get_job(job_id)
                if not cached:
                    raise HTTPException(status_code=404, detail="Forecast job not found.")
                cached["cancelled"] = True
                cached["status"] = "CANCELLED"
                engine.cache.save_job(cached)
                return JobCreatedResponse(jobId=job_id, status="CANCELLED")
            raise HTTPException(status_code=404, detail="Forecast job not found.")

        jobs[job_id]["cancelled"] = True
        if jobs[job_id]["status"] in ("QUEUED", "RUNNING"):
            jobs[job_id]["status"] = "CANCELLED"
            jobs[job_id]["endTime"] = time.time()
            jobs[job_id]["elapsedSeconds"] = round(jobs[job_id]["endTime"] - jobs[job_id]["startTime"], 2)
        if hasattr(engine, "cache") and engine.cache:
            engine.cache.save_job(jobs[job_id])

        return JobCreatedResponse(jobId=job_id, status="CANCELLED")


@app.get("/api/forecast/cache/metrics")
def get_cache_metrics():
    """Returns database storage and row counts for cache observability."""
    try:
        if hasattr(engine, "cache") and engine.cache:
            return engine.cache.get_cache_metrics()
        return {"enabled": False}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ProcurementScheduleRequest(BaseModel):
    startMonth: Optional[str] = None
    targetArrivalDate: Optional[str] = None
    leadTimeDays: Optional[int] = 45
    referenceDate: Optional[str] = None


@app.post("/api/procurement/schedule")
def get_procurement_schedule(req: ProcurementScheduleRequest):
    """Calculates procurement lead-time scheduling, cutoff deadline, and overdue status."""
    try:
        from .heuristics import calculate_procurement_schedule
        start_m = req.startMonth or req.targetArrivalDate or "2026-11"
        return calculate_procurement_schedule(
            start_month=start_m,
            lead_time_days=req.leadTimeDays,
            reference_date=req.referenceDate
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/forecast/segmentation")
def segment_skus(req: SegmentationRequest):
    try:
        items_payload = [item.model_dump() for item in req.items]
        return segment_sku_population(items_payload, req.config)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/forecast/batch")
def predict_batch(req: BatchForecastRequest):
    try:
        if req.allowedCategories:
            allowed_set = set(cat.strip().upper() for cat in req.allowedCategories)
            invalid_items = []
            for it in req.items:
                cls = classify_sku(it.itemCode, it.history, description=it.description or "", item_group=it.itemGroup or "")
                if cls["category"] not in allowed_set:
                    invalid_items.append(f"{it.itemCode} ({cls['category']})")
            if invalid_items:
                raise HTTPException(
                    status_code=400,
                    detail=f"Scope violation: {len(invalid_items)} item(s) do not belong to requested category scope {req.allowedCategories}: {', '.join(invalid_items[:5])}"
                )

        items_payload = [item.model_dump() for item in req.items]
        candidate_pool_payload = (
            [item.model_dump() for item in req.candidatePool]
            if req.candidatePool is not None
            else None
        )
        return engine.forecast_batch(
            items=items_payload,
            horizon=req.horizon,
            start_month=req.startMonth,
            candidate_pool=candidate_pool_payload
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/forecast/explain", response_model=ExplanationResponse)
def explain_forecast(req: ExplanationRequest):
    try:
        return generate_explanation(req.model_dump())
    except Exception as e:
        # Fallback to unavailable on unexpected top-level failure
        return ExplanationResponse(
            unavailable=True,
            reason=f"AI response could not be validated. Numerical forecast is unaffected. ({str(e)})"
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=False)
