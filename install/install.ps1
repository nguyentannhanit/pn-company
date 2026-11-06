# =============================================================================
# P&N — Cài đặt trên máy Windows.
#
# Chạy được nhiều lần: bước nào đã xong thì bỏ qua, không ghi đè .env đang có.
# Không tự tải phần mềm về máy — thiếu gì thì nói rõ lệnh cần chạy, vì cài ngầm
# một database lên máy người khác là việc không được phép làm thay họ.
# =============================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$failed = $false

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    [ok] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    [!] $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "    [LOI] $text" -ForegroundColor Red; $script:failed = $true }

Write-Host ""
Write-Host "  P&N — Build. Learn. Evolve." -ForegroundColor Magenta
Write-Host "  Cai dat cong ty phan mem AI" -ForegroundColor DarkGray

# --- 1. Node.js -------------------------------------------------------------
Step "Kiem tra Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail "Chua co Node.js. Cai bang: winget install OpenJS.NodeJS.LTS  (roi mo lai cua so nay)"
} else {
    $version = (& node -v).TrimStart('v')
    $major = [int]($version.Split('.')[0])
    if ($major -lt 20) {
        Fail "Node.js $version qua cu. Can tu 20.10 tro len: winget install OpenJS.NodeJS.LTS"
    } else {
        Ok "Node.js $version"
    }
}

# --- 2. PostgreSQL ----------------------------------------------------------
Step "Kiem tra PostgreSQL"
$psql = $null
$command = Get-Command psql -ErrorAction SilentlyContinue
if ($command) {
    $psql = $command.Source
} else {
    # @() bat buoc ket qua thanh mang: mot ket qua duy nhat se tra ve chuoi,
    # va [0] tren chuoi cat ra dung mot ky tu chu khong phai duong dan.
    $candidates = @(
        Get-ChildItem 'C:\Program Files\PostgreSQL' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' } |
            Where-Object { Test-Path $_ }
    )
    if ($candidates.Count -gt 0) { $psql = $candidates[0] }
}

if (-not $psql) {
    Fail "Chua co PostgreSQL. Cai bang: winget install PostgreSQL.PostgreSQL.17  (nho mat khau ban dat cho user postgres)"
} else {
    Ok "psql: $psql"
}

if ($failed) {
    Write-Host ""
    Write-Host "  Cai nhung thu tren roi chay lai cai-dat.cmd." -ForegroundColor Yellow
    exit 1
}

# --- 3. Database ------------------------------------------------------------
# Cho phep doi ten database de cai duoc ban thu ben canh ban dang dung.
$dbName = 'pn_company'
if ($env:PN_DB_NAME) { $dbName = $env:PN_DB_NAME }
Step "Chuan bi database $dbName"

$dbUser = 'postgres'
$dbHost = '127.0.0.1'
$dbPort = '5432'

if (-not $env:PGPASSWORD) {
    $secure = Read-Host "    Mat khau cua user postgres" -AsSecureString
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$exists = & $psql -U $dbUser -h $dbHost -p $dbPort -d postgres -t -A -c "SELECT 1 FROM pg_database WHERE datname = '$dbName'" 2>$null
if ($LASTEXITCODE -ne 0) {
    Fail "Khong ket noi duoc PostgreSQL. Kiem tra dich vu da chay va mat khau da dung."
    exit 1
}
if ($exists -match '1') {
    Ok "database $dbName da co san"
} else {
    & $psql -U $dbUser -h $dbHost -p $dbPort -d postgres -q -c "CREATE DATABASE $dbName" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Khong tao duoc database $dbName"; exit 1 }
    Ok "da tao database $dbName"
}

# --- 4. Tep .env ------------------------------------------------------------
Step "Chuan bi tep .env"
$envPath = Join-Path $root '.env'
if (Test-Path $envPath) {
    Ok ".env da co — giu nguyen, khong ghi de"
} else {
    # Ba khoa nay sinh ngau nhien tren chinh may nay. Doi PN_MASTER_KEY sau do
    # se lam moi secret da luu khong giai ma duoc nua (§70).
    $master = & node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    $jwt = & node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
    $service = & node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
    $password = $env:PGPASSWORD

    $content = Get-Content (Join-Path $root '.env.example') -Raw -Encoding UTF8
    $content = $content -replace 'DATABASE_URL=.*', "DATABASE_URL=postgresql://${dbUser}:${password}@${dbHost}:${dbPort}/${dbName}"
    $content = $content -replace 'PN_MASTER_KEY=.*', "PN_MASTER_KEY=$master"
    $content = $content -replace 'JWT_SECRET=.*', "JWT_SECRET=$jwt"
    $content = $content -replace 'PN_SERVICE_SECRET=.*', "PN_SERVICE_SECRET=$service"
    [IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding $false))
    Ok "da tao .env voi khoa ma hoa rieng cho may nay"
    Warn "Sao luu tep .env. Mat PN_MASTER_KEY la mat toan bo API key da luu."
}

# --- 5. Thu vien ------------------------------------------------------------
Step "Cai thu vien (mat vai phut lan dau)"
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "npm install that bai"; exit 1 }
Ok "da cai xong"

# --- 6. Bien dich -----------------------------------------------------------
Step "Bien dich ma nguon"
& npm run build
if ($LASTEXITCODE -ne 0) { Fail "bien dich backend that bai"; exit 1 }
Ok "backend"

& npm run build:web
if ($LASTEXITCODE -ne 0) { Fail "bien dich dashboard that bai"; exit 1 }
Ok "dashboard"

# --- 7. Migration -----------------------------------------------------------
Step "Tao bang trong database"
& node --env-file-if-exists=.env packages/database/dist/cli.js migrate
if ($LASTEXITCODE -ne 0) { Fail "chay migration that bai"; exit 1 }
Ok "database da san sang"

# --- 8. Kiem tra lai --------------------------------------------------------
Step "Chay bo test"
& npm test
if ($LASTEXITCODE -ne 0) { Warn "co test khong dat — xem log ben tren" } else { Ok "toan bo test dat" }

Write-Host ""
Write-Host "  Cai dat xong." -ForegroundColor Green
Write-Host ""
Write-Host "  Buoc tiep theo:" -ForegroundColor White
Write-Host "    1. Chay  chay.cmd  de khoi dong"
Write-Host "    2. Mo    http://localhost:3000"
Write-Host "    3. Tao tai khoan CEO dau tien ngay tren trang do"
Write-Host "    4. Vao Cai dat -> AI Providers, dan API key roi bam Test Connection"
Write-Host ""
