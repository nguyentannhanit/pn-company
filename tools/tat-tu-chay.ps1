# P&N — Tat che do tu chay (xoa tac vu he thong). He thong dang chay van chay tiep;
# dung han thi chay them dung.cmd.
$ErrorActionPreference = 'SilentlyContinue'
$name = 'P&N Company'
if (Get-ScheduledTask -TaskName $name) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "[ok] Da xoa tac vu '$name'. Tu gio phai bam chay.cmd bang tay." -ForegroundColor Green
} else {
    Write-Host "    Khong co tac vu '$name' nao de xoa." -ForegroundColor DarkGray
}
