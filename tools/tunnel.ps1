# Mở hai đường hầm Cloudflare (quick tunnel, không cần tài khoản): một cho API
# (cổng 4000), một cho dashboard (cổng 3000), để điện thoại ở ngoài gọi được
# công ty đang chạy trên máy này. Ghi địa chỉ vào logs/tunnel.env cho API đọc
# khi khởi động (API_PUBLIC_URL cho link sản phẩm, WEB_TUNNEL_ORIGIN cho CORS).
# Địa chỉ đổi mỗi lần mở lại; tools/tunnel-notify.mjs báo địa chỉ mới qua Telegram.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$exe = Join-Path $root 'tools\bin\cloudflared.exe'
if (-not (Test-Path $exe)) { Write-Output "Thieu $exe (tai tu github.com/cloudflare/cloudflared/releases)"; exit 1 }

function Open-Tunnel($name, $port) {
  $pidFile = Join-Path $logs "tunnel-$name.pid"
  $log = Join-Path $logs "tunnel-$name.log"
  if (Test-Path $pidFile) {
    $old = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
    if ($old) { Stop-Process -Id $old.Id -Force }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
  if (Test-Path $log) { Remove-Item $log -ErrorAction SilentlyContinue }
  $proc = Start-Process $exe `
    -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$port" `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs "tunnel-$name.out.log") -RedirectStandardError $log
  Set-Content $pidFile $proc.Id
  foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $log) {
      # Loai api.trycloudflare.com: do la may chu cap phat, xuat hien trong dong LOI khi mat mang.
      $m = Select-String -Path $log -Pattern 'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
      if ($m) { return $m.Matches[0].Value }
    }
  }
  return $null
}

# Bản đầu của script chỉ mở một đường hầm và ghi logs/tunnel.pid; dọn nốt nếu còn.
$legacy = Join-Path $logs 'tunnel.pid'
if (Test-Path $legacy) {
  $old = Get-Process -Id ([int](Get-Content $legacy)) -ErrorAction SilentlyContinue
  if ($old) { Stop-Process -Id $old.Id -Force }
  Remove-Item $legacy -ErrorAction SilentlyContinue
}

# Duong ham CO TEN (link co dinh): co tools\named-tunnel.json (tools\tunnel-setup.ps1 tao) thi chay MOT tien trinh
# phuc vu ca hai ten mien. Ghi cung PID vao hai pid file de start.ps1, stop.ps1 va bo canh khong phai doi.
# Mo khong duoc thi tat no roi lui ve duong ham tam ben duoi, de cong ty khong mat loi vao.
function Open-NamedTunnel {
  $file = Join-Path $PSScriptRoot 'named-tunnel.json'
  if (-not (Test-Path $file)) { return $null }
  $cfg = Get-Content $file -Raw | ConvertFrom-Json
  foreach ($old in @('api', 'web')) {
    $pidFile = Join-Path $logs "tunnel-$old.pid"
    if (Test-Path $pidFile) {
      $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
      if ($p) { Stop-Process -Id $p.Id -Force }
      Remove-Item $pidFile -ErrorAction SilentlyContinue
    }
  }
  $log = Join-Path $logs 'tunnel-named.log'
  if (Test-Path $log) { Remove-Item $log -ErrorAction SilentlyContinue }
  $proc = Start-Process $exe `
    -ArgumentList 'tunnel', '--no-autoupdate', '--config', ('"' + (Join-Path $root $cfg.config) + '"'), 'run', $cfg.name `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'tunnel-named.out.log') -RedirectStandardError $log
  foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { break }
    if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Registered tunnel connection' -Quiet)) {
      Set-Content (Join-Path $logs 'tunnel-api.pid') $proc.Id
      Set-Content (Join-Path $logs 'tunnel-web.pid') $proc.Id
      return @{ api = "https://api.$($cfg.domain)"; web = "https://$($cfg.domain)" }
    }
  }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  Write-Host 'Duong ham co ten khong ket noi duoc, lui ve duong ham tam.'
  return $null
}

$namedTunnel = Open-NamedTunnel
if ($namedTunnel) {
  Set-Content (Join-Path $logs 'tunnel.env') @("API_PUBLIC_URL=$($namedTunnel.api)", "WEB_TUNNEL_ORIGIN=$($namedTunnel.web)") -Encoding ascii
  Write-Output "API:  $($namedTunnel.api)"
  Write-Output "Web:  $($namedTunnel.web)"
  exit 0
}

$api = Open-Tunnel 'api' 4000
$web = Open-Tunnel 'web' 3000
# Khong mo duoc thi giu nguyen tunnel.env cu, dung ghi rac; bo canh se thu lai.
if (-not $api -or -not $web -or $api -eq $web) { Write-Output "Khong mo duoc duong ham (api=$api web=$web)"; exit 1 }
Set-Content (Join-Path $logs 'tunnel.env') @("API_PUBLIC_URL=$api", "WEB_TUNNEL_ORIGIN=$web") -Encoding ascii
Write-Output "API:  $api"
Write-Output "Web:  $web"
