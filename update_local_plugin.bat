@echo off
setlocal
chcp 65001 >nul

set "BRANCH=cursor/cloud-agent-1786241119826-ukk8w"
set "REPO=%~dp0"

cd /d "%REPO%"
echo.
echo ==================================================
echo   更新 YouTube 实时中文配音 Cursor 插件
echo ==================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [失败] 没有找到 Git。请先安装 Git for Windows。
  goto :failed
)

if not exist ".git" (
  echo [失败] 此脚本必须放在项目根目录运行：
  echo        C:\video\Youtube_Claude_Codex_cursor0805
  goto :failed
)

for /f %%i in ('git status --porcelain') do (
  echo [停止] 本地有尚未提交的修改。为避免覆盖文件，本次没有更新。
  echo.
  git status --short
  goto :failed
)

echo [1/3] 获取云端更新...
git fetch origin "%BRANCH%"
if errorlevel 1 goto :git_failed

echo [2/3] 切换到插件更新分支...
git switch "%BRANCH%" >nul 2>nul
if errorlevel 1 (
  git switch --track -c "%BRANCH%" "origin/%BRANCH%"
  if errorlevel 1 goto :git_failed
)

echo [3/3] 下载最新文件...
git pull --ff-only origin "%BRANCH%"
if errorlevel 1 goto :git_failed

echo.
echo [完成] 本地插件已更新。
echo 插件文件夹：
echo %REPO%chrome_extension
echo.
echo 接下来请打开 Chrome 扩展管理页 chrome://extensions/
echo 然后点击该插件的“重新加载”按钮。
echo.
explorer "%REPO%chrome_extension"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
  start "" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" "chrome://extensions/"
) else if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "chrome://extensions/"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "chrome://extensions/"
) else (
  echo 未自动找到 Chrome，请手动打开 chrome://extensions/
)
pause
exit /b 0

:git_failed
echo.
echo [失败] Git 更新失败，请检查网络和上方错误信息。

:failed
echo.
pause
exit /b 1
