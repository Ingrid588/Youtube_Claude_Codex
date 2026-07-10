# Runs daily via Windows Task Scheduler: syncs the newest YouTube cookies.txt
# in the Downloads folder to the Cloud Run service dub-server's
# YT_COOKIES_CONTENT environment variable.
#
# Cloud Run cookies used to be a one-time env var set at deploy time, and never
# auto-updated when a fresh cookies.txt appeared in the local Downloads folder.
# This script closes that gap.
#
# Uses --update-env-vars (merge-style update, only touches this one variable),
# so it never disturbs the other secrets (GEMINI_API_KEY, LEMONSQUEEZY_API_KEY).
#
# "Newest" logic mirrors live_dub_server.py's get_cookies_file(): any .txt file
# in Downloads whose name contains both "youtube" and "cookie" (case-insensitive),
# picking the one with the newest mtime. The extension now auto-exports one
# daily to www.youtube.com_cookies_auto.txt; a manually exported file (from the
# old workflow) still wins if it happens to be newer.

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $PSScriptRoot 'sync_cookies_log.txt'

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

try {
    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    $candidates = Get-ChildItem -Path $downloads -Filter '*.txt' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '(?i)youtube' -and $_.Name -match '(?i)cookie' }

    if (-not $candidates -or $candidates.Count -eq 0) {
        Write-Log 'No youtube cookie file found in Downloads, skipping this run'
        exit 0
    }

    $newest = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Log "Using file: $($newest.FullName) (modified $($newest.LastWriteTime))"

    $content = Get-Content -Raw -Path $newest.FullName -Encoding utf8

    $envVarArg = "YT_COOKIES_CONTENT=$content"
    # gcloud writes its progress text to stderr; under $ErrorActionPreference='Stop',
    # redirecting a native command's stderr via 2>&1 wraps each line as a terminating
    # NativeCommandError. Localize to 'Continue' just for this call so we can capture
    # and log the output without it throwing.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & gcloud run services update dub-server --region us-central1 --update-env-vars=$envVarArg 2>&1 | Out-String
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -ne 0) {
        Write-Log "gcloud exited with code $LASTEXITCODE. Output:`n$output"
    } else {
        Write-Log "gcloud output:`n$output"
        Write-Log 'Sync completed'
    }
} catch {
    Write-Log "Sync failed: $($_.Exception.Message)"
}
