@echo off
setlocal
if "%~1"=="" (
  echo Drag a WebM file onto this batch file, or run: convert_to_mp4.bat input.webm
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo FFmpeg is required. Install from https://ffmpeg.org/download.html and add it to PATH.
  pause
  exit /b 1
)
ffmpeg -y -i "%~1" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart -an "%~dpn1.mp4"
pause
