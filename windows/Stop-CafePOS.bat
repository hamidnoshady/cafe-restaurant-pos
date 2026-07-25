@echo off
REM ===========================================================================
REM  Stop-CafePOS.bat  (Phase 12)
REM
REM  Cleanly stops the POS containers (app + Postgres). Your data is kept in
REM  Docker volumes, so nothing is lost — starting again restores everything.
REM
REM  You normally DON'T need this: the containers restart automatically and
REM  it's fine to just close the app window or shut the laptop down. Use this
REM  only when you want to fully stop the POS (e.g. before maintenance).
REM ===========================================================================

cd /d "%~dp0.."

echo [Cafe POS] Stopping the POS containers...
docker compose -f docker-compose.local.yml stop

echo [Cafe POS] Stopped. Run Start-CafePOS to bring it back.
pause
