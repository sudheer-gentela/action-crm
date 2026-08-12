<#
=====================================================================
 filter-pavan.ps1  —  reduce big Mongo NDJSON pools to Pavan's slice
                       BEFORE loading into Postgres, so we never stage
                       all-tenant data (this is what caused the crash).

 Pavan user_id (Mongo): 6630bb9fe336850c87a0a1d6
 Aquarient tenant_id  : 6630baa9e336850c87a0a1d5

 Run in stages (see banners). Steps 1 runs now; Steps 3/4 run AFTER
 02_load_pavan.sql has produced pavan_ids.txt / pavan_account_ids.txt.
=====================================================================
#>

param(
    [ValidateSet('custom_attrs','contacts','orgs','linkedin')]
    [string]$Step = 'custom_attrs'
)

$BASE       = "C:\Projects\MongoDB Backup"
$PAVAN_USER = "6630bb9fe336850c87a0a1d6"

function Show-Size($path) {
    if (Test-Path $path) {
        $mb = [math]::Round((Get-Item $path).Length/1MB,1)
        $n  = (Get-Content $path | Measure-Object -Line).Lines
        Write-Host ("  -> {0}  ({1} rows, {2} MB)" -f (Split-Path $path -Leaf), $n, $mb) -ForegroundColor Green
    }
}

# ---------------------------------------------------------------------
# STEP 1  filter contact_custom_attributes -> Pavan only
# ---------------------------------------------------------------------
if ($Step -eq 'custom_attrs') {
    Write-Host "STEP 1: filtering contact_custom_attributes to Pavan..." -ForegroundColor Cyan
    $in  = "$BASE\_user_scoped\contact_custom_attributes.ndjson"
    $out = "$BASE\_user_scoped\cca_pavan.ndjson"
    $w = [System.IO.StreamWriter]::new($out, $false, (New-Object System.Text.UTF8Encoding($false)))
    $pat = '"user_id"\s*:\s*\{\s*"\$oid"\s*:\s*"' + $PAVAN_USER + '"'
    Get-Content $in | ForEach-Object {
        if ($_ -match $pat) { $w.WriteLine($_) }
    }
    $w.Close()
    Show-Size $out
    Write-Host "Load it with:  \copy stg.contact_custom_attrs(doc) FROM '$out' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
}

# ---------------------------------------------------------------------
# STEP linkedin  filter the 3 LinkedIn collections -> Pavan only
# ---------------------------------------------------------------------
if ($Step -eq 'linkedin') {
    Write-Host "STEP linkedin: filtering LinkedIn collections to Pavan..." -ForegroundColor Cyan
    $pat = '"user_id"\s*:\s*\{\s*"\$oid"\s*:\s*"' + $PAVAN_USER + '"'
    # some LinkedIn collections may store user_id as a plain string, not a DBRef/oid:
    $patStr = '"user_id"\s*:\s*"' + $PAVAN_USER + '"'

    $files = @(
        @{ in="$BASE\_user_scoped\linkedin_messages.ndjson";         out="$BASE\_user_scoped\li_messages_pavan.ndjson" },
        @{ in="$BASE\_user_scoped\linkedin_message_history.ndjson";  out="$BASE\_user_scoped\li_msg_history_pavan.ndjson" },
        @{ in="$BASE\_user_scoped\user_linkedin_connections.ndjson"; out="$BASE\_user_scoped\li_connections_pavan.ndjson" }
    )
    foreach ($f in $files) {
        if (-not (Test-Path $f.in)) { Write-Host "  skip (missing): $($f.in)" -ForegroundColor Yellow; continue }
        $w = [System.IO.StreamWriter]::new($f.out, $false, (New-Object System.Text.UTF8Encoding($false)))
        Get-Content $f.in | ForEach-Object {
            if ($_ -match $pat -or $_ -match $patStr) { $w.WriteLine($_) }
        }
        $w.Close()
        Show-Size $f.out
    }
    Write-Host "Load with (set client_encoding UTF8 first):"
    Write-Host "  \copy stg.linkedin_messages(doc)         FROM '$BASE\_user_scoped\li_messages_pavan.ndjson'    WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
    Write-Host "  \copy stg.linkedin_message_history(doc)  FROM '$BASE\_user_scoped\li_msg_history_pavan.ndjson' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
    Write-Host "  \copy stg.user_linkedin_connections(doc) FROM '$BASE\_user_scoped\li_connections_pavan.ndjson' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
}

if ($Step -eq 'contacts') {
    Write-Host "STEP 3: filtering global contacts to Pavan's id set..." -ForegroundColor Cyan
    $idfile = "$BASE\pavan_ids.txt"
    if (-not (Test-Path $idfile)) { Write-Host "MISSING $idfile - run 02_load_pavan.sql first." -ForegroundColor Red; exit 1 }

    $idSet = [System.Collections.Generic.HashSet[string]]::new()
    Get-Content $idfile | ForEach-Object { $t=$_.Trim(); if ($t) { [void]$idSet.Add($t) } }
    Write-Host ("  loaded {0} Pavan contact ids" -f $idSet.Count)

    $in  = "$BASE\_global\contacts.ndjson"
    $out = "$BASE\_global\contacts_pavan.ndjson"
    $w = [System.IO.StreamWriter]::new($out, $false, (New-Object System.Text.UTF8Encoding($false)))
    $seen = 0
    Get-Content $in | ForEach-Object {
        if ($_ -match '"_id"\s*:\s*\{\s*"\$oid"\s*:\s*"([0-9a-f]{24})"') {
            if ($idSet.Contains($matches[1])) { $w.WriteLine($_); $seen++ }
        }
    }
    $w.Close()
    Write-Host ("  matched {0} contacts" -f $seen)
    Show-Size $out
    Write-Host "Load it with:  \copy stg.contacts(doc) FROM '$out' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
}

# ---------------------------------------------------------------------
# STEP 4  filter global contact_organizations -> only accounts Pavan's
#         contacts reference. Requires pavan_account_ids.txt.
# ---------------------------------------------------------------------
if ($Step -eq 'orgs') {
    Write-Host "STEP 4: filtering contact_organizations to Pavan's account set..." -ForegroundColor Cyan
    $idfile = "$BASE\pavan_account_ids.txt"
    if (-not (Test-Path $idfile)) { Write-Host "MISSING $idfile - run the account-id step in 02_load_pavan.sql first." -ForegroundColor Red; exit 1 }

    $idSet = [System.Collections.Generic.HashSet[string]]::new()
    Get-Content $idfile | ForEach-Object { $t=$_.Trim(); if ($t) { [void]$idSet.Add($t) } }
    Write-Host ("  loaded {0} account ids" -f $idSet.Count)

    $in  = "$BASE\_global\contact_organizations.ndjson"
    $out = "$BASE\_global\contact_orgs_pavan.ndjson"
    $w = [System.IO.StreamWriter]::new($out, $false, (New-Object System.Text.UTF8Encoding($false)))
    $seen = 0
    Get-Content $in | ForEach-Object {
        if ($_ -match '"_id"\s*:\s*\{\s*"\$oid"\s*:\s*"([0-9a-f]{24})"') {
            if ($idSet.Contains($matches[1])) { $w.WriteLine($_); $seen++ }
        }
    }
    $w.Close()
    Write-Host ("  matched {0} organizations" -f $seen)
    Show-Size $out
    Write-Host "Load it with:  \copy stg.contact_organizations(doc) FROM '$out' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
}
