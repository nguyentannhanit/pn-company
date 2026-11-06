# =============================================================================
# P&N — Dung he thong.
#
# Chi giet dung nhung tien trinh do chay.cmd khoi dong (doc PID da ghi lai),
# khong quet va giet moi tien trinh node tren may — nguoi dung con viec khac.
# =============================================================================

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root 'logs'

$stopped = 0
foreach ($name in @('api', 'web', 'worker', 'bot', 'tunnel-watch', 'tunnel-api', 'tunnel-web')) {
    $file = Join-Path $logs "$name.pid"
    if (-not (Test-Path $file)) { continue }
    $processId = [int](Get-Content $file)
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
        Stop-Process -Id $processId -Force
        Write-Host "    [ok] da dung $name (PID $processId)" -ForegroundColor Green
        $stopped += 1
    }
    Remove-Item $file -ErrorAction SilentlyContinue
}

if ($stopped -eq 0) {
    Write-Host "    khong co tien trinh nao dang chay" -ForegroundColor DarkGray
} else {
    Write-Host ""
    Write-Host "  Da dung P&N." -ForegroundColor Green
}
