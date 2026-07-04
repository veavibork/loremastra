# Pull checkpointed SQLite data from the GCP VM into data/vm-sync/ (does not overwrite live data/).
# Usage: .\scripts\pull-remote-data.ps1

$ErrorActionPreference = "Stop"
$Zone = "us-central1-b"
$Instance = "instance-20260703-183143"
$RemoteRoot = "/opt/loremaster"
$LocalRoot = Join-Path $PSScriptRoot ".." | Resolve-Path
$SyncRoot = Join-Path $LocalRoot "data\vm-sync"
$Stories = Join-Path $SyncRoot "stories"
New-Item -ItemType Directory -Force -Path $Stories | Out-Null

Write-Host "Checkpointing WAL on VM..."
gcloud compute scp "$LocalRoot\scripts\checkpoint-sqlite.mjs" "${Instance}:${RemoteRoot}/scripts/checkpoint-sqlite.mjs" --zone=$Zone
gcloud compute ssh $Instance --zone=$Zone --command="cd $RemoteRoot && node scripts/checkpoint-sqlite.mjs $RemoteRoot"

function Pull-Db($RemotePath, $LocalPath) {
  $tmp = "$LocalPath.part"
  Write-Host "Pull $RemotePath"
  gcloud compute scp "${Instance}:${RemotePath}" $tmp --zone=$Zone
  Move-Item $tmp $LocalPath -Force
}

Pull-Db "$RemoteRoot/data/global.sqlite" (Join-Path $SyncRoot "global.sqlite")

$storyIds = @(
  "019f1f08-2fc0-758c-8208-353d3154f239",
  "019f246b-b66d-770b-9614-509cfa15d78d",
  "019f25e0-219c-7189-b481-9f389a9a3c39",
  "019f2964-915a-76d6-8ed1-6f9a4d046394"
)
foreach ($id in $storyIds) {
  Pull-Db "$RemoteRoot/data/stories/$id.sqlite" (Join-Path $Stories "$id.sqlite")
}

Write-Host ""
Write-Host "Synced to data/vm-sync/"
Write-Host "Main story: 019f25e0-219c-7189-b481-9f389a9a3c39"
Write-Host ""
Write-Host '$env:LOREMASTER_DATA_DIR = "data/vm-sync"'
Write-Host 'npx tsx scripts/story-to-date-experiment.ts list'
