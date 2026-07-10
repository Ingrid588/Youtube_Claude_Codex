@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ════════════════════════════════════════
echo  YouTube Cookie 检查工具
echo ════════════════════════════════════════
echo.

set "DOWNLOADS=%USERPROFILE%\Downloads"
set "FOUND=0"

echo 📁 下载文件夹: %DOWNLOADS%
echo.

REM 查找所有包含 youtube 的 cookie 文件
for /f "delims=" %%F in ('dir /b /o-d "%DOWNLOADS%\*cookie*.txt" 2^>nul ^| findstr /i "youtube youtu"') do (
    if !FOUND! equ 0 (
        set "LATEST=%%F"
        set "FOUND=1"
    )
)

if !FOUND! equ 0 (
    echo ❌ 未找到 youtube cookies.txt 文件
    echo.
    echo 📌 操作步骤：
    echo    1. 打开 Chrome（普通窗口，不是无痕）
    echo    2. 登录 YouTube (https://youtube.com)
    echo    3. 点浏览器右上角的扩展程序图标
    echo    4. 找 "Get cookies.txt LOCALLY" 点击
    echo    5. 点蓝色 "Export" 按钮（只导出当前页面）
    echo    6. 文件会下载到下载文件夹
    echo    7. 之后关闭浏览器或标签页（不要点登出！）
    echo    8. 再运行一次这个 bat 来验证
    echo.
    pause
    exit /b 1
)

echo ✓ 找到最新的 cookie 文件：
echo.
echo   文件名: !LATEST!
echo   位置: %DOWNLOADS%\!LATEST!
echo.

REM 检查文件大小
for %%A in ("%DOWNLOADS%\!LATEST!") do (
    set "SIZE=%%~zA"
    echo   文件大小: !SIZE! 字节
)
echo.

REM 检查文件格式
for /f "usebackq delims=" %%L in ("%DOWNLOADS%\!LATEST!") do (
    set "FIRST=%%L"
    goto :check_format
)

:check_format
if "!FIRST:Netscape=!" == "!FIRST!" (
    echo ❌ 文件格式错误（不是 Netscape 格式）
    echo    可能导出失败了，请重试
    echo.
    pause
    exit /b 1
)

echo ✓ 文件格式正确 (Netscape Cookie Format)
echo.

REM 统计 cookie 条数
setlocal enabledelayedexpansion
set "COUNT=0"
for /f "usebackq delims=" %%L in ("%DOWNLOADS%\!LATEST!") do (
    set "LINE=%%L"
    if not "!LINE:~0,1!"="#" (
        set /a COUNT+=1
    )
)

echo ✓ 包含 !COUNT! 条 cookie
echo.
echo 🎉 Cookie 验证通过！
echo.
echo 📝 说明：
echo    • 服务器每 30 秒自动检查最新的 youtube cookies.txt
echo    • 无需手动复制或配置，自动使用
echo    • Cookie 大概 2-4 周失效一次
echo    • 失效后按上面步骤重新导出即可
echo.
pause
