@echo off
rem Nachtelijke cyclus voor de Windows-taakplanner (handleiding 8).
rem Draait vanuit de repo-map; .env en vrsctest.conf worden door de scripts zelf gelezen.
cd /d "%~dp0\..\.."
set "VERUS_OPERATOR_ACK=RUN_VRSCTEST_DAILY_CYCLE"
node scripts\operator\daily-cycle.mjs --max-wait 900
if %ERRORLEVEL%==3 node scripts\operator\daily-cycle.mjs --max-wait 900
exit /b %ERRORLEVEL%
