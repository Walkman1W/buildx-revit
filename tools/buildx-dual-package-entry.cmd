@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -File "%~dp0packages\2024\tools\buildx-setup.ps1" -BundleRoot "%~dp0."
if errorlevel 1 (
  echo BuildX setup could not start. Check Windows PowerShell execution policy and the installation files.
  pause
)
