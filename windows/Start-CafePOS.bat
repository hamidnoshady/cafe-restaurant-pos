@echo off
REM ===========================================================================
REM  Start-CafePOS.bat  (Phase 12)
REM
REM  The ONE thing the café staff double-clicks each day. It:
REM    1. Makes sure Docker Desktop is running (starts it if not).
REM    2. Brings the POS stack up (app + Postgres) via docker compose.
REM    3. Waits until the app answers on http://localhost:3000.
REM    4. Checks whether a newer version is available (self-update, see
REM       docs/server-sync.md "Self-update") and if so, pulls and restarts
REM       with it — never blocks a normal boot if this fails or is skipped.
REM    5. Opens the POS in its own app window (Edge/Chrome --app), so it
REM       looks and behaves like native software, no address bar, no tabs.
REM
REM  Normally launched HIDDEN through Start-CafePOS.vbs (no console flashes).
REM  Run this .bat directly only when you want to see what's happening.
REM
REM  It cd's to the repo root (the folder ABOVE this "windows" folder) so it
REM  works no matter where the shortcut lives.
REM ===========================================================================

setlocal EnableExtensions EnableDelayedExpansion

REM --- Move to the repo root (parent of this script's "windows" folder) ------
cd /d "%~dp0.."

set "APP_URL=http://localhost:3000"
set "COMPOSE_FILE=docker-compose.local.yml"

echo [Cafe POS] Starting... working directory: %CD%

REM --- 1. Ensure Docker engine is up ----------------------------------------
docker info >nul 2>&1
if errorlevel 1 (
    echo [Cafe POS] Docker is not running yet. Launching Docker Desktop...
    if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
        start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
    ) else (
        echo [Cafe POS] Could not find Docker Desktop. Please install it once.
    )

    REM Wait up to ~120s for the Docker engine to accept commands.
    set /a _tries=0
    :waitdocker
    docker info >nul 2>&1
    if not errorlevel 1 goto dockerready
    set /a _tries+=1
    if !_tries! geq 60 (
        echo [Cafe POS] Docker did not start in time. Aborting.
        goto end
    )
    timeout /t 2 /nobreak >nul
    goto waitdocker
)
:dockerready
echo [Cafe POS] Docker engine is ready.

REM --- 2. Bring the POS stack up (idempotent; no-op if already running) ------
echo [Cafe POS] Starting the POS containers...
docker compose -f "%COMPOSE_FILE%" up -d
if errorlevel 1 (
    echo [Cafe POS] Failed to start containers. See the message above.
    goto end
)

REM --- 3. Wait until the app answers on the port ----------------------------
echo [Cafe POS] Waiting for the app to be ready at %APP_URL% ...
set /a _tries=0
:waitapp
curl -s -o nul "%APP_URL%" >nul 2>&1
if not errorlevel 1 goto appready
set /a _tries+=1
if !_tries! geq 60 (
    echo [Cafe POS] App did not respond in time, opening the window anyway.
    goto openapp
)
timeout /t 2 /nobreak >nul
goto waitapp
:appready
echo [Cafe POS] App is up.

REM --- 3.5. Self-update: check for a newer version, pull and restart if so --
REM Never fatal — any failure here just falls through to opening the current
REM version. See scripts/check-app-update.ts and docs/server-sync.md
REM "Self-update" for what this is actually checking and why it's safe.
echo [Cafe POS] Checking for an update...
set "UPDATE_TMP=%TEMP%\cafepos-update-check.txt"
docker compose -f "%COMPOSE_FILE%" exec -T app npx tsx scripts/check-app-update.ts > "%UPDATE_TMP%" 2>nul

set "UPDATE_LINE1="
set "UPDATE_LINE2="
set "UPDATE_LINE3="
set /a _line=0
if exist "%UPDATE_TMP%" (
    for /f "usebackq delims=" %%L in ("%UPDATE_TMP%") do (
        set /a _line+=1
        if !_line! EQU 1 set "UPDATE_LINE1=%%L"
        if !_line! EQU 2 set "UPDATE_LINE2=%%L"
        if !_line! EQU 3 set "UPDATE_LINE3=%%L"
    )
    del "%UPDATE_TMP%" >nul 2>&1
)

if "!UPDATE_LINE1!"=="UPDATE" (
    echo [Cafe POS] Update available: !UPDATE_LINE2!
    REM The token is short-lived (~1h, minted fresh for this one login) and
    REM never touches disk — piped straight into docker login's stdin.
    echo !UPDATE_LINE3! | docker login ghcr.io -u x-access-token --password-stdin >nul 2>&1
    if errorlevel 1 (
        echo [Cafe POS] Registry login failed; continuing with the current version.
    ) else (
        echo [Cafe POS] Pulling the new version...
        docker compose -f "%COMPOSE_FILE%" pull app
        if errorlevel 1 (
            echo [Cafe POS] Pull failed; continuing with the current version.
        ) else (
            docker compose -f "%COMPOSE_FILE%" up -d
            echo [Cafe POS] Updated. Waiting for the app to come back up...
            set /a _tries=0
            :waitapp2
            curl -s -o nul "%APP_URL%" >nul 2>&1
            if not errorlevel 1 goto appready2
            set /a _tries+=1
            if !_tries! geq 60 goto appready2
            timeout /t 2 /nobreak >nul
            goto waitapp2
            :appready2
            echo [Cafe POS] Update complete.
        )
    )
) else (
    echo [Cafe POS] Already on the latest version.
)

REM --- 4. Open the POS in its own app window --------------------------------
:openapp
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME_X86=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%" (
    start "" "%EDGE%" --app=%APP_URL%
) else if exist "%CHROME%" (
    start "" "%CHROME%" --app=%APP_URL%
) else if exist "%CHROME_X86%" (
    start "" "%CHROME_X86%" --app=%APP_URL%
) else (
    REM No Edge/Chrome found: fall back to the default browser.
    start "" "%APP_URL%"
)

:end
endlocal
