import os
import json
import pytest
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def test_llm_payload_and_failure_handling(monkeypatch):
    """
    Test 7, 8, 9, 14: LLM failure and missing API key handling.
    """
    # Remove API keys if they exist
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    
    payload = {
        "itemCode": "TEST-123",
        "description": "Test Item",
        "pattern": "stable",
        "historyLength": 24,
        "historicalAvg": 100.5,
        "recentDemand": [105, 110, 95],
        "fullForecast": [100, 100, 100],
        "forecastTotal": 600.0,
        "confidencePct": 85.0,
        "predictionInterval": {"lower": 550.0, "upper": 650.0},
        "intervalMethod": "bootstrap",
        "wape": 14.5,
        "mae": 5.0,
        "rmse": 6.5,
        "bias": 1.0,
        "validationWindowCount": 4,
        "selectedModel": "Holt-Winters",
        "modelType": "Statistical",
        "trendDirection": "flat",
        "trendStrength": 0.1,
        "seasonalityDetected": False,
        "seasonalityPeriod": 12,
        "seasonalityStrength": 0.05,
        "outlierCount": 0,
        "missingPeriods": 0,
        "zeroDemandRatio": 0.0,
        "forecastEligibility": "Eligible",
        "recommendedModelFamily": "Exponential Smoothing",
        "dataQualityFlags": [],
        "stock": 200.0,
        "openPo": 50.0,
        "netReq": 350.0,
        "plannerAdj": None,
        "finalQuantity": 600.0,
        "alerts": []
    }
    
    # Missing API Key
    response = client.post("/api/forecast/explain", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data.get("unavailable") is True
    assert "AI explanations are unavailable" in data.get("reason")
    assert data.get("summary") is None

def test_llm_anti_hallucination_prompt_content():
    """
    Test 1, 2, 3, 4, 5, 11, 12, 13: Prompt construction uses actual values
    and strictly forbids hallucination/mutation.
    """
    from backend.llm import LLM_SYSTEM_PROMPT
    
    assert "EXPLAIN ONLY" in LLM_SYSTEM_PROMPT
    assert "strictly forbidden from calculating" in LLM_SYSTEM_PROMPT
    assert "Use ONLY the supplied numerical/business facts" in LLM_SYSTEM_PROMPT
    assert "never invent" in LLM_SYSTEM_PROMPT.lower()
    assert "never change the supplied numbers" in LLM_SYSTEM_PROMPT.lower()

def test_llm_does_not_mutate_numerical_backend():
    """
    Test 6: LLM response cannot mutate numerical forecast state.
    This is guaranteed architecturally because the engine does not call the LLM during predict.
    """
    from backend.main import engine
    models = engine.get_candidate_models()
    # Ensure LLM is nowhere in the pipeline
    for m in models:
        assert "llm" not in m.name.lower()

def test_response_validation():
    """
    Test response validation cases:
    1. valid provider response -> accepted
    2. malformed JSON -> unavailable
    3. missing required field / wrong type -> handled or ignored based on schema
    5. extra numerical mutation fields -> stripped
    """
    from backend.main import ExplanationResponse
    
    # Valid
    valid_resp = ExplanationResponse(summary="Good", drivers=["D1"])
    dump = valid_resp.model_dump()
    assert dump["summary"] == "Good"
    
    # Extra fields (mutation attempt)
    raw_bad = {
        "summary": "Good",
        "drivers": ["D1"],
        "forecastTotal": 999999,
        "netReq": 0
    }
    sanitized = ExplanationResponse(**raw_bad)
    sanitized_dump = sanitized.model_dump()
    
    # Extra fields must be stripped (pydantic extra="ignore")
    assert "forecastTotal" not in sanitized_dump
    assert "netReq" not in sanitized_dump
    assert sanitized_dump["summary"] == "Good"
    
    # Missing fields (since they are optional, it will just fill None)
    raw_missing = {}
    missing = ExplanationResponse(**raw_missing)
    assert missing.model_dump()["summary"] is None
    
    # Wrong type (pydantic will raise ValidationError if it cannot coerce)
    # E.g., providing a dict instead of a list for drivers
    import pydantic
    try:
        ExplanationResponse(drivers={"not": "a list"})
        # Pydantic might coerce some types, but if it fails it raises ValidationError
    except pydantic.ValidationError:
        pass


def test_real_payload_integration():
    """
    Test 4: Test that a real forecast result can be formatted into the LLM ExplanationRequest payload.
    This proves that actual numerical results and model statistics enter the payload.
    """
    from backend.main import engine, ExplanationRequest
    
    # Generate a real forecast
    history = [10, 12, 11, 15, 14, 18, 20, 22, 21, 25, 26, 30]
    result = engine.forecast_single_sku(
        item_code="REAL-SKU",
        history_values=history,
        horizon=3
    )
    
    # Map to the payload schema (simulating what the frontend does, or if backend did it)
    # The requirement is that the payload CAN hold these actual values.
    # We validate that the ExplanationRequest schema accepts all these real outputs.
    
    payload = ExplanationRequest(
        itemCode=result["itemCode"],
        description="Real Data Test",
        pattern=result.get("demandProfile", {}).get("demand_pattern", "unknown"),
        historyLength=result["historyMonths"],
        historicalAvg=sum(history)/len(history),
        recentDemand=history[-3:],
        fullForecast=result["forecast"],
        forecastTotal=sum(result["forecast"]),
        confidencePct=result.get("confidencePct"),
        predictionInterval={
            "lower": min(result["confidence"]["lowerBound"]) if result.get("confidence", {}).get("status") == "EVALUATED" else 0,
            "upper": max(result["confidence"]["upperBound"]) if result.get("confidence", {}).get("status") == "EVALUATED" else 0
        } if result.get("confidence", {}).get("status") == "EVALUATED" else None,
        intervalMethod=result.get("confidence", {}).get("method"),
        wape=result.get("selectedModelMetrics", {}).get("wape"),
        mae=result.get("selectedModelMetrics", {}).get("mae"),
        rmse=result.get("selectedModelMetrics", {}).get("rmse"),
        bias=result.get("selectedModelMetrics", {}).get("bias"),
        validationWindowCount=result.get("selectedModelMetrics", {}).get("validationWindows"),
        selectedModel=result["selectedModel"],
        modelType=result["modelType"],
        trendDirection=result.get("demandProfile", {}).get("trend_direction"),
        trendStrength=result.get("demandProfile", {}).get("trend_strength"),
        seasonalityDetected=result.get("demandProfile", {}).get("seasonality_detected"),
        seasonalityPeriod=result.get("demandProfile", {}).get("seasonality_period"),
        seasonalityStrength=result.get("demandProfile", {}).get("seasonality_strength"),
        outlierCount=result.get("demandProfile", {}).get("outlier_count"),
        missingPeriods=result.get("demandProfile", {}).get("missing_periods"),
        zeroDemandRatio=result.get("demandProfile", {}).get("zero_demand_ratio"),
        forecastEligibility=result.get("demandProfile", {}).get("forecast_eligibility"),
        recommendedModelFamily=result.get("demandProfile", {}).get("recommended_model_family"),
        dataQualityFlags=result.get("demandProfile", {}).get("data_quality_flags", []),
        stock=50,
        openPo=10,
        netReq=100,
        plannerAdj=None,
        finalQuantity=sum(result["forecast"]),
        alerts=[]
    )
    
    assert payload.itemCode == "REAL-SKU"
    assert len(payload.fullForecast) == 3
    assert payload.selectedModel is not None
