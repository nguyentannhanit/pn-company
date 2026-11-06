# Cai duong ham Cloudflare CO TEN (link co dinh) cho P&N. Chay MOT LAN sau khi ten mien da "Active" tren Cloudflare:
#   powershell -ExecutionPolicy Bypass -File tools\tunnel-setup.ps1 -Domain example.com
# Cac buoc: dang nhap Cloudflare (mo trinh duyet, CEO bam Authorize) -> tao duong ham -> tro ten mien
# (goc = dashboard, api.<ten mien> = API) -> ghi tools\named-tunnel.yml + named-tunnel.json.
# Sau do tools\tunnel.ps1 tu dung duong ham co ten thay cho duong ham tam (trycloudflare).
param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [string]$Name = 'pn-company'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$exe = Join-Path $root 'tools\bin\cloudflared.exe'
if (-not (Test-Path $exe)) { throw "Thieu $exe" }
$home_cf = Join-Path $env:USERPROFILE '.cloudflared'

# 1. Dang nhap: cert.pem la giay phep quan ly ten mien nay (khong phai mat khau).
if (-not (Test-Path (Join-Path $home_cf 'cert.pem'))) {
  Write-Output 'Dang nhap Cloudflare: trinh duyet se mo, chon ten mien va bam Authorize...'
  & $exe tunnel login
  if (-not (Test-Path (Join-Path $home_cf 'cert.pem'))) { throw 'Chua dang nhap duoc Cloudflare (khong thay cert.pem)' }
}

# 2. Tao duong ham neu chua co (chay lai script van an toan).
$existing = (& $exe tunnel list --output json | ConvertFrom-Json) | Where-Object { $_.name -eq $Name } | Select-Object -First 1
if (-not $existing) {
  Write-Output "Tao duong ham $Name..."
  & $exe tunnel create $Name
  $existing = (& $exe tunnel list --output json | ConvertFrom-Json) | Where-Object { $_.name -eq $Name } | Select-Object -First 1
}
if (-not $existing) { throw "Khong tao duoc duong ham $Name" }
$id = $existing.id
$credentials = Join-Path $home_cf "$id.json"
if (-not (Test-Path $credentials)) { throw "Thieu tep khoa duong ham: $credentials (duong ham tao tu may khac?)" }

# 3. Tro hai ten vao duong ham (co san roi thi bao loi nhe, khong dung).
foreach ($host_name in @($Domain, "api.$Domain")) {
  Write-Output "Tro $host_name -> $Name"
  & $exe tunnel route dns --overwrite-dns $Name $host_name
}

# 4. Ghi cau hinh may nay (khong dua len git).
$config = @(
  "tunnel: $id",
  "credentials-file: $credentials",
  'ingress:',
  "  - hostname: api.$Domain",
  '    service: http://127.0.0.1:4000',
  "  - hostname: $Domain",
  '    service: http://127.0.0.1:3000',
  '  - service: http_status:404'
)
Set-Content (Join-Path $root 'tools\named-tunnel.yml') $config -Encoding ascii
@{ name = $Name; domain = $Domain; config = 'tools\named-tunnel.yml' } | ConvertTo-Json | Set-Content (Join-Path $root 'tools\named-tunnel.json') -Encoding ascii
Write-Output "Xong. Link co dinh: https://$Domain (API: https://api.$Domain)"
Write-Output 'Chay tiep: powershell -File tools\tunnel.ps1'
