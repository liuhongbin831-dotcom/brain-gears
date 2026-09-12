@echo off
cd /d "%~dp0"

for /f "tokens=1 delims= " %%a in ("%date%") do set d=%%a
for /f "tokens=1 delims=. " %%a in ("%time%") do set t=%%a
set d=%d:/=-%
set t=%t::=%
set t=%t: =0%

git add -A
git commit -m "Archive %d% %t%"
git push

echo.
echo Archived: %d% %t%
pause
