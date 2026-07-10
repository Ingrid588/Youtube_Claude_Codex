@echo off
title 配音服务管理

:menu
cls
echo ============================================
echo             配音服务  一键管理
echo ============================================
echo.
echo 当前在跑的相关进程：
echo.
powershell -NoProfile -Command "$list=Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'live_dub_server\.py|app\.py' }; if(-not $list){ Write-Host '    (无相关进程在跑)' -ForegroundColor DarkGray } else { foreach($p in $list){ if($p.CommandLine -match 'live_dub_server'){$tag='配音服务器  (8765, 实时/扩展)'} elseif($p.CommandLine -match 'app\.py'){$tag='批量配音工具 (7860, Gemini)'} else {$tag='其他'}; Write-Host ('    PID {0,-7} {1}' -f $p.ProcessId, $tag) } }"
echo.
echo --------------------------------------------
echo   [1] 关闭  配音服务器   (8765)
echo   [2] 关闭  批量配音工具 (7860)
echo   [A] 全部关闭
echo   [R] 刷新列表
echo   [Q] 退出
echo --------------------------------------------
set "choice="
set /p "choice=请输入选项后回车: "

if /i "%choice%"=="1" goto kill_server
if /i "%choice%"=="2" goto kill_app
if /i "%choice%"=="A" goto kill_all
if /i "%choice%"=="R" goto menu
if /i "%choice%"=="Q" exit /b
goto menu

:kill_server
powershell -NoProfile -Command "$ps=Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'live_dub_server\.py' }; if($ps){ $ps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host '已关闭 配音服务器' -ForegroundColor Green } else { Write-Host '没有在跑的配音服务器' -ForegroundColor Yellow }"
echo.
pause
goto menu

:kill_app
powershell -NoProfile -Command "$ps=Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'app\.py' }; if($ps){ $ps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host '已关闭 批量配音工具' -ForegroundColor Green } else { Write-Host '没有在跑的批量配音工具' -ForegroundColor Yellow }"
echo.
pause
goto menu

:kill_all
powershell -NoProfile -Command "$ps=Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'live_dub_server\.py|app\.py' }; if($ps){ $ps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host '已全部关闭' -ForegroundColor Green } else { Write-Host '当前没有相关进程在跑' -ForegroundColor Yellow }"
echo.
pause
goto menu