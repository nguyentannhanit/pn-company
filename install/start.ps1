# =============================================================================
# P&N — Khoi dong he thong.
#
# Chay API va dashboard o nen, ghi log ra thu muc logs/, roi doi den khi API
# thuc su tra loi moi bao la xong. Bao "da chay" ngay sau khi goi lenh la noi
# doi: tien trinh co the chet sau do vi thieu database.
# =============================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    [ok] $text" -ForegroundColor Green }
function Fail($text) { Write-Host "    [LOI] $text" -ForegroundColor Red }

if (-not (Test-Path (Join-Path $root '.env'))) {
    Fail "Chua co .env. Chay cai-dat.cmd truoc."
    exit 1
}
if (-not (Test-Path (Join-Path $root 'apps\api\dist\index.js'))) {
    Fail "Chua bien dich. Chay cai-dat.cmd truoc."
    exit 1
}

$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory $logs | Out-Null }

# Bo canh goi lai script nay khi mot dich vu chet, nen phan nao con song phai
# duoc bo qua — bat chong len se gianh cong 4000/3000 va lam hong ca hai.
function Alive($name) {
    $file = Join-Path $logs "$name.pid"
    if (-not (Test-Path $file)) { return $false }
    return [bool](Get-Process -Id ([int](Get-Content $file)) -ErrorAction SilentlyContinue)
}

# Doc cong tu .env de thong bao dung dia chi, khong doan.
$envText = Get-Content (Join-Path $root '.env') -Raw
$apiPort = 4000
if ($envText -match 'API_PORT=(\d+)') { $apiPort = [int]$Matches[1] }
$webPort = 3000
if ($envText -match 'WEB_PUBLIC_URL=https?://[^:]+:(\d+)') { $webPort = [int]$Matches[1] }

# .env co REDIS_URL nhung Redis khong chay thi API chi xep viec vao hang doi va
# khong ai lam. Khi do chay che do mot tien trinh: ghi de REDIS_URL rong.
$redisReady = $false
if ($envText -match 'REDIS_URL=redis://[^\s:/]+:(\d+)') {
    $redisPort = [int]$Matches[1]
    try {
        $probe = New-Object System.Net.Sockets.TcpClient
        $probe.Connect('127.0.0.1', $redisPort)
        $redisReady = $probe.Connected
        $probe.Close()
    } catch { }
}
if ($redisReady) {
    Remove-Item (Join-Path $logs 'no-redis.env') -ErrorAction SilentlyContinue
} else {
    Set-Content (Join-Path $logs 'no-redis.env') 'REDIS_URL=' -Encoding ascii
}

# Duong ham Cloudflare de dien thoai o ngoai vao duoc. Khong bat buoc: thieu
# cloudflared thi bo qua, he thong van chay trong mang noi bo.
if ((Alive 'tunnel-api') -and (Alive 'tunnel-web')) {
    Step "Duong ham da mo san"
} elseif (Test-Path (Join-Path $root 'tools\bin\cloudflared.exe')) {
    Step "Mo duong ham ra ngoai"
    & (Join-Path $root 'tools\tunnel.ps1')
} else {
    Remove-Item (Join-Path $logs 'tunnel.env') -ErrorAction SilentlyContinue
}

if (Alive 'api') {
    Step "API da chay san"
} else {
Step "Khoi dong API"
$api = Start-Process node `
    -ArgumentList '--env-file-if-exists=.env', '--env-file-if-exists=logs/no-redis.env', '--env-file-if-exists=logs/tunnel.env', 'apps/api/dist/index.js' `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$logs\api.log" -RedirectStandardError "$logs\api.err.log"
Set-Content (Join-Path $logs 'api.pid') $api.Id

$ready = $false
foreach ($attempt in 1..40) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-RestMethod "http://127.0.0.1:$apiPort/ready" -TimeoutSec 2
        if ($response.ok) { $ready = $true; break }
    } catch { }
}
if ($ready) {
    Ok "API tra loi tai http://localhost:$apiPort"
} else {
    Fail "API khong len duoc. Xem logs\api.err.log"
    exit 1
}
}

if (Alive 'web') {
    Step "Dashboard da chay san"
} else {
Step "Khoi dong dashboard"
$web = Start-Process node `
    -ArgumentList '--env-file-if-exists=logs/tunnel.env', './node_modules/next/dist/bin/next', 'start', 'apps/web', '-p', "$webPort" `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$logs\web.log" -RedirectStandardError "$logs\web.err.log"
Set-Content (Join-Path $logs 'web.pid') $web.Id

$up = $false
foreach ($attempt in 1..40) {
    Start-Sleep -Milliseconds 500
    try {
        $status = (Invoke-WebRequest "http://127.0.0.1:$webPort/login" -TimeoutSec 2 -UseBasicParsing).StatusCode
        if ($status -eq 200) { $up = $true; break }
    } catch { }
}
if ($up) {
    Ok "Dashboard tai http://localhost:$webPort"
} else {
    Fail "Dashboard khong len duoc. Xem logs\web.err.log"
    exit 1
}
}

# Co REDIS_URL thi API chi xep viec vao hang doi; phai co worker moi co ai chay.
# Thieu buoc nay thi task nam im mai ma khong loi nao phat ra.
if ($redisReady) {
    Step "Khoi dong worker"
    $worker = Start-Process node `
        -ArgumentList '--env-file-if-exists=.env', 'apps/worker/dist/index.js' `
        -WorkingDirectory $root -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\worker.log" -RedirectStandardError "$logs\worker.err.log"
    Set-Content (Join-Path $logs 'worker.pid') $worker.Id
    Ok "worker dang chay (can Redis tai $($Matches[1]))"
}

# Bot Telegram xin token tu API Center (hoac env). Luon thu bat: chua cau hinh
# thi no tu thoat va ghi ly do vao logs\bot.err.log, khong lam hong phan con lai.
if (Alive 'bot') {
    Step "Bot Telegram da chay san"
} else {
Step "Khoi dong bot Telegram"
$bot = Start-Process node `
    -ArgumentList '--env-file-if-exists=.env', 'apps/telegram-bot/dist/index.js' `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$logs\bot.log" -RedirectStandardError "$logs\bot.err.log"
Set-Content (Join-Path $logs 'bot.pid') $bot.Id
Start-Sleep -Seconds 4
if (Get-Process -Id $bot.Id -ErrorAction SilentlyContinue) {
    Ok "bot dang chay"
} else {
    Write-Host "    [bo qua] bot khong len: xem logs\bot.err.log (chua cau hinh Telegram?)" -ForegroundColor DarkGray
}
}

# Dia chi duong ham doi moi lan mo; bao qua Telegram khi khac lan truoc.
if (Test-Path (Join-Path $logs 'tunnel.env')) {
    & node --env-file-if-exists=.env tools/tunnel-notify.mjs | Out-Null

    # Bo canh: Cloudflare xoa duong ham thi tu mo lai va bao dia chi moi.
    # Dang co mot bo canh song thi giu nguyen, tranh hai bo cung mo lai duong ham.
    $watchPid = Join-Path $logs 'tunnel-watch.pid'
    $watchAlive = (Test-Path $watchPid) -and (Get-Process -Id ([int](Get-Content $watchPid)) -ErrorAction SilentlyContinue)
    if ($watchAlive) {
        Ok "bo canh da chay san"
    } else {
        Step "Khoi dong bo canh"
        $watch = Start-Process node `
            -ArgumentList '--env-file-if-exists=.env', 'tools/tunnel-watch.mjs' `
            -WorkingDirectory $root -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logs 'tunnel-watch.log') -RedirectStandardError (Join-Path $logs 'tunnel-watch.err.log')
        Set-Content (Join-Path $logs 'tunnel-watch.pid') $watch.Id
        Ok "bo canh dang chay"
    }
}

Write-Host ""
Write-Host "  P&N dang chay." -ForegroundColor Green
Write-Host "  Mo http://localhost:$webPort" -ForegroundColor White
Write-Host "  Dung lai bang dung.cmd" -ForegroundColor DarkGray
Write-Host ""
