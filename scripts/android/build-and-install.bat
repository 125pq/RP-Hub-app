@echo off
chcp 65001 >nul
setlocal
title RP Hub - 一键打 debug 包并安装到手机
color 0A

echo ============================================
echo   RP Hub 一键 debug 打包 + 安装
echo ============================================
echo.

set "SCRIPT_DIR=%~dp0"
set "SCRIPT=%SCRIPT_DIR%build-and-install.ps1"

if not exist "%SCRIPT%" (
    echo [ERROR] 找不到脚本: %SCRIPT%
    pause
    exit /b 1
)

echo [*] 开始执行一键链路（打 debug 包 -^> adb 连接 -^> 安装）...
echo     如需跳过构建用现成 APK:  build-and-install.bat -SkipBuild
echo     如需只构建不安装:       build-and-install.bat -SkipInstall
echo.
echo     按任意键开始，或关闭窗口取消...
pause >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
    echo ============================================
    echo   完成：debug 包已安装到手机。
    echo ============================================
    color 0A
) else (
    echo ============================================
    echo   失败：退出码 %EXITCODE%。请查看上方错误信息。
    echo ============================================
    color 0C
)
echo.
pause
endlocal
