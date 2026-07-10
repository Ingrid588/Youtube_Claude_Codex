@echo off
setlocal
cd /d "%~dp0"

if "%~4"=="" (
  echo 用法:
  echo   run_merge_dubbed_video.bat 原视频.mp4 变速日志.json 配音.mp3 输出.mp4
  echo.
  echo 示例:
  echo   run_merge_dubbed_video.bat "D:\video\src.mp4" "D:\video\xxx_ratelog.json" "D:\video\xxx_dubbing.mp3" "D:\video\done.mp4"
  exit /b 1
)

python merge_dubbed_video.py %*
