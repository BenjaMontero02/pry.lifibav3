@echo off
setlocal

set "ROOT=%~dp0.."
cd /d "%ROOT%"

echo [build-python] Building Python executable with PyInstaller...
pyinstaller --clean --noconfirm python\build.spec
if errorlevel 1 (
  echo [build-python] PyInstaller build failed.
  exit /b 1
)

if not exist "resources\python" mkdir "resources\python"

echo [build-python] Copying executable to resources\python...
if exist "dist\python-child.exe" (
  copy /Y "dist\python-child.exe" "resources\python\python-child.exe" >nul
) else if exist "dist\python-child\python-child.exe" (
  copy /Y "dist\python-child\python-child.exe" "resources\python\python-child.exe" >nul
) else (
  echo [build-python] Could not find python-child.exe in dist.
  exit /b 1
)

echo [build-python] Done.
exit /b 0
