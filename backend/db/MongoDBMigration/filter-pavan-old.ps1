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
    [ValidateSet('custom_attrs','contacts','orgs')]
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
    $w = [System.IO.StreamWriter]::new($out, $false, [System.Text.Encoding]::UTF8)
    $pat = '"user_id"\s*:\s*\{\s*"\$oid"\s*:\s*"' + $PAVAN_USER + '"'
    Get-Content $in | ForEach-Object {
        if ($_ -match $pat) { $w.WriteLine($_) }
    }
    $w.Close()
    Show-Size $out
    Write-Host "Load it with:  \copy stg.contact_custom_attrs(doc) FROM '$out' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')"
}

# ---------------------------------------------------------------------
# STEP 3  filter global contacts -> only Pavan's referenced contact ids
#         Requires pavan_ids.txt (produced by 02_load_pavan.sql).
# ---------------------------------------------------------------------
if ($Step -eq 'contacts') {
    Write-Host "STEP 3: filtering global contacts to Pavan's id set..." -ForegroundColor Cyan
    $idfile = "$BASE\pavan_ids.txt"
    if (-not (Test-Path $idfile)) { Write-Host "MISSING $idfile - run 02_load_pavan.sql first." -ForegroundColor Red; exit 1 }

    $idSet = [System.Collections.Generic.HashSet[string]]::new()
    Get-Content $idfile | ForEach-Object { $t=$_.Trim(); if ($t) { [void]$idSet.Add($t) } }
    Write-Host ("  loaded {0} Pavan contact ids" -f $idSet.Count)

    $in  = "$BASE\_global\contacts.ndjson"
    $out = "$BASE\_global\contacts_pavan.ndjson"
    $w = [System.IO.StreamWriter]::new($out, $false, [System.Text.Encoding]::UTF8)
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
    $w = [System.IO.StreamWriter]::new($out, $false, [System.Text.Encoding]::UTF8)
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
