@echo off
setlocal
rem FayaNMS operator entry — Windows dispatcher (delegates to PowerShell core ops/ops.ps1).
rem Linux/macOS use bash ops/ops.sh — identical command surface, pinned by tests/audit/ga9-ops-scripts.test.ts
set "SCRIPT_DIR=%~dp0"
where pwsh >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%ops.ps1" %*
  exit /b %ERRORLEVEL%
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%ops.ps1" %*
exit /b %ERRORLEVEL%
