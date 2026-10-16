@echo off
setlocal enabledelayedexpansion
title Demandora AI Platform - Startup

echo ===============================================================================
echo       DEMANDORA - AI-POWERED DEMAND & SUPPLY INTELLIGENCE PLATFORM
echo ===============================================================================
echo.

cd /d "%~dp0"

echo [1/4] Checking Python and Node.js environments...
set "PYTHON_EXE="
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
    echo [OK] Using virtual environment Python: !PYTHON_EXE!
) else (
    where python >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PYTHON_EXE=python"
        echo [OK] Using system Python
    ) else (
        echo [ERROR] Python is not installed or not in PATH, and .venv was not found!
        pause
        exit /b 1
    )
)

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    pause
    exit /b 1
)

echo [2/4] Starting FastAPI ML Backend Server (Port 8000)...
start "Demandora - Backend ML Service (Port 8000)" cmd /k "cd /d ""%~dp0"" && ""!PYTHON_EXE!"" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000"

echo [3/4] Starting Frontend Dev Server (Port 3000)...
start "Demandora - Frontend Web App (Port 3000)" cmd /k "cd /d ""%~dp0"" && npx.cmd vite --host 0.0.0.0 --port 3000"

echo [4/4] Opening application in browser...
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo.
echo ===============================================================================
echo   SUCCESS! Demandora services are running:
echo     - Frontend Web App:  http://localhost:3000  or  http://127.0.0.1:3000
echo     - Backend ML Engine: http://127.0.0.1:8000
echo     - API Documentation: http://127.0.0.1:8000/docs
echo ===============================================================================
echo.
pause
