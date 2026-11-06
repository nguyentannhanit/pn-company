# =============================================================================
# P&N — Cho cong ty tu chay, khong phu thuoc cua so nao.
#
# Truoc day API/web/bot duoc bat tu mot cua so PowerShell; cua so do dong la ca
# he thong chet theo (nut "Mo P&N" khong phan hoi vi moi thu da tat 16
# tieng truoc). Tac vu he thong chay o phien rieng nen song tiep, va tu bat lai
# moi lan dang nhap Windows.
#
# Bat:  tu-chay.cmd      Tat:  tat-tu-chay.cmd
# =============================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'P&N Company'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'install\start.ps1') + '"') `
    -WorkingDirectory $root

# Dang nhap Windows la chay; tre 30 giay cho mang va Docker/Postgres len truoc.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT30S'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Khoi dong API, dashboard, bot Telegram va duong ham cua P&N' -Force | Out-Null

Write-Host "[ok] Da tao tac vu '$name': tu chay moi lan dang nhap Windows." -ForegroundColor Green
Start-ScheduledTask -TaskName $name
Write-Host "[ok] Da chay ngay bay gio. Xem trang thai: schtasks /query /tn `"$name`"" -ForegroundColor Green
