$path = "C:\Projects\MongoDB Backup\_user_scoped\li_connections_pavan.ndjson"
$content = [System.IO.File]::ReadAllText($path)
$content = $content.TrimStart([char]0xFEFF)   # remove BOM char
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
Write-Host "BOM stripped"

C:\Projects\MongoDB Backup\_user_scoped\li_messages_pavan.ndjson
C:\Projects\MongoDB Backup\_user_scoped\li_msg_history_pavan.ndjson
C:\Projects\MongoDB Backup\_user_scoped\li_connections_pavan.ndjson