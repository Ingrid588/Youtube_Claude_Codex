@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo ==========================================
echo 后台配音包 + 本地视频 合成工具
echo ==========================================
echo.
echo 第一次运行会自动初始化下载目录下的 dub_workspace。
echo 请把：
echo   1. 原视频放到 dub_workspace\source_videos
echo   2. 插件下载的后台配音包 zip 放到 dub_workspace\segments
echo.
echo 合成结果会输出到 dub_workspace\output
echo.

python retime_video.py init
if errorlevel 1 (
  echo.
  echo 初始化失败。请确认已安装 Python，并且当前目录下存在 retime_video.py。
  pause
  exit /b 1
)

echo.
echo 开始扫描并合成...
python retime_video.py merge-all
if errorlevel 1 (
  echo.
  echo 合成过程中出现错误。请检查上方提示，常见原因：
  echo   - 没有安装 ffmpeg/ffprobe，或未加入 PATH
  echo   - 原视频没有放到 dub_workspace\source_videos
  echo   - 后台配音包没有放到 dub_workspace\segments
  echo   - 原视频名称与配音包名称差异太大，无法自动匹配
  pause
  exit /b 1
)

echo.
echo 全部完成。
pause
