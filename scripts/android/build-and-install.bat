@echo off
chcp 65001 >nul
setlocal
title RP Hub - Build and install debug APK
color 0A

echo ============================================
echo   RP Hub debug build + install
echo ============================================
echo.

set "SCRIPT_DIR=%~dp0"
set "SCRIPT=%SCRIPT_DIR%build-and-install.ps1"

if not exist "%SCRIPT%" (
    echo [ERROR] Script not found: %SCRIPT%
    pause
    exit /b 1
)

echo [*] Running build ^> adb detection ^> install...
echo     Skip build:  build-and-install.bat -SkipBuild
echo     Skip install: build-and-install.bat -SkipInstall
echo.
echo     Press any key to start, or close this window to cancel...
pause >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
    echo ============================================
    echo   Done: debug APK installed.
    echo ============================================
    color 0A
) else (
    echo ============================================
    echo   Failed: exit code %EXITCODE%. See the error output above.
    echo ============================================
    color 0C
)
echo.
pause
endlocal & exit /b %EXITCODE%
