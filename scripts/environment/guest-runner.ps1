param([Parameter(Mandatory=$true)][string]$RequestFile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
# No filesystem mutation, installer or process launch precedes these independent guards.
$r = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
$b = $r.binding
$run = [guid]::Parse($b.runId).ToString()
$environment = [guid]::Parse($b.environmentId).ToString()
$root = "C:\CetaMeshEnv\$run"
if ($r.version -ne 1 -or $r.guestRoot -cne $root -or $RequestFile -cne "$root\request.json") { throw 'GUEST_REQUEST_PATH' }
$guard = Get-Content -LiteralPath "$root\guard.json" -Raw | ConvertFrom-Json
$system = Get-CimInstance Win32_ComputerSystem
$uuid = (Get-CimInstance Win32_ComputerSystemProduct).UUID
if ($guard.version -ne 1 -or $guard.runId -ne $run -or $guard.environmentId -ne $environment -or $guard.guestVmId -ne $uuid -or $system.Manufacturer -ne 'Microsoft Corporation' -or $system.Model -ne 'Virtual Machine') { throw 'GUEST_GUARD_REJECTED' }
if ($b.capability -ne 'environment.test' -or $b.expiresAt -le (Now) -or $b.limits.timeoutMs -le 0) { throw 'GUEST_BINDING_EXPIRED' }
$deadline = [Math]::Min([double]$b.expiresAt, (Now) + [double]$b.limits.timeoutMs)
function OwnedPath([string]$relative) {
  if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or $relative.Contains(':')) { throw 'GUEST_PATH_ESCAPE' }
  $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
  if (-not $path.StartsWith("$root\",[StringComparison]::OrdinalIgnoreCase)) { throw 'GUEST_PATH_ESCAPE' }
  $cursor = $path
  while ($cursor.Length -ge $root.Length) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'GUEST_REPARSE_POINT' }
    $cursor = Split-Path -Parent $cursor
  }
  return $path
}
$null = OwnedPath 'request.json'
. (OwnedPath 'runner/guest-core.ps1')
$definitions = [ordered]@{W01=@('artifact-hashes','install-exit','installed-files','build-info');W02=@('gui-process','gui-window');W03=@('model-step4','chat-reached');W04=@('core-ipc','task-attempt','memory','workspace','permission','error');W05=@('managed-tool-roundtrip','task-progress','cancel-propagation','real-provider');W06=@('cancel-owned','crash-restart','unknown-outcome');W07=@('upgrade','uninstall')}
if ($r.mode -notin @('lifecycle-fixture','cetamesh') -or @($r.packIds).Count -eq 0 -or @($r.packIds | Select-Object -Unique).Count -ne @($r.packIds).Count) { throw 'GUEST_REQUEST_INVALID' }
foreach ($id in $r.packIds) { if (-not $definitions.Contains($id)) { throw 'GUEST_PACK_UNKNOWN' } }
$started = Now
$checks = New-Object 'Collections.Generic.List[object]'
function Check([string]$pack,[string]$id,[string]$status,[string]$code,$observations=@{},$exitCode=$null) {
  $layer = 'Windows VM E2E'
  if ($pack -in @('W04','W06')) { $layer = 'Integration' }
  if ($pack -eq 'W05') { $layer = 'Integration'; if ($id -eq 'real-provider') { $layer = 'Real Provider E2E' } }
  if ($r.mode -eq 'lifecycle-fixture') { $layer = 'Unit/Fixture' }
  $item = @{packId=$pack;id=$id;status=$status;layer=$layer;code=$code;observations=$observations;startedAt=$started;endedAt=(Now)}
  if ($null -ne $exitCode) { $item.exitCode = $exitCode }
  $checks.Add($item)
  # Fixed fields only: no raw stdout, request bodies, provider secrets or authToken.
  [IO.File]::AppendAllText((OwnedPath 'evidence/steps.jsonl'),((@{packId=$pack;checkId=$id;status=$status;code=$code;at=(Now)}|ConvertTo-Json -Compress)+[Environment]::NewLine),(New-Object Text.UTF8Encoding($false)))
}
# A crash or repeated invocation must never silently replay an installer.
$sentinel = [IO.File]::Open((OwnedPath 'runner.started'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$sentinel.Dispose()
$evidenceDir = OwnedPath 'evidence'
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$installed = $false; $uiSessionPrepared=$false; $uiDispatched=$false
try {
  if ($r.mode -eq 'lifecycle-fixture') {
    $probe = OwnedPath 'evidence/lifecycle.txt'
    [IO.File]::WriteAllText($probe, $run)
    if ([IO.File]::ReadAllText($probe) -ne $run) { throw 'FIXTURE_FILE_ROUNDTRIP' }
    # This proves only bootstrap/file lifecycle. Product checks remain explicitly unrun.
  } else {
    if ($r.artifact.installer -ne 'input/WhaleBridge.exe' -or $r.artifact.payloadDir -ne 'input/payload') { throw 'CANDIDATE_LAYOUT' }
    $installer = OwnedPath $r.artifact.installer
    $files = @($r.artifact.files)
    if ($files.Count -eq 0) { throw 'CANDIDATE_MANIFEST_EMPTY' }
    $seen = @{}
    foreach ($file in $files) {
      if ($seen.ContainsKey($file.path.ToLowerInvariant())) { throw 'CANDIDATE_DUPLICATE_PATH' }
      if ($file.path -notmatch '^input/' -or $file.path.Contains('\')) { throw 'CANDIDATE_FILE_SCOPE' }
      $seen[$file.path.ToLowerInvariant()] = $true
      $path = OwnedPath $file.path
      if ((Get-Item -LiteralPath $path).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) { throw 'CANDIDATE_HASH_MISMATCH' }
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath (OwnedPath 'input') -Recurse -Force)) {
      $relative = $entry.FullName.Substring($root.Length + 1).Replace('\','/')
      $null = OwnedPath $relative
      if (-not $entry.PSIsContainer -and -not $seen.ContainsKey($relative.ToLowerInvariant())) { throw 'CANDIDATE_UNPINNED_FILE' }
    }
    if (-not $seen.ContainsKey('input/whalebridge.exe') -or -not $seen.ContainsKey('input/payload/whalebridgecore.exe')) { throw 'CANDIDATE_REQUIRED_FILE_MISSING' }
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $r.artifact.installerSha256) { throw 'INSTALLER_HASH_MISMATCH' }
    if ($r.packIds -contains 'W01') { Check W01 artifact-hashes PASS OBSERVED @{actual=$true;files=$files.Count;installerSha256=$r.artifact.installerSha256} }
    $install = OwnedPath 'installed'
    $data = OwnedPath 'data'
    $installArgs = @('--install','--install-dir',$install,'--data-dir',$data,'--start-menu-dir',(OwnedPath 'start-menu'),'--desktop-dir',(OwnedPath 'desktop'),'--registry-key',"HKCU\Software\WhaleBridgeTest\environment-$run",'--no-dsh-integration')
    $process = Start-Process -FilePath $installer -ArgumentList $installArgs -WindowStyle Hidden -PassThru
    $remaining = [Math]::Max(1,[Math]::Min(300000,$deadline - (Now)))
    if (-not $process.WaitForExit([int]$remaining)) { $process.Kill(); $null=$process.WaitForExit(5000); throw 'INSTALL_TIMEOUT_UNKNOWN_OUTCOME' }
    $process.Refresh()
    if ($r.packIds -contains 'W01') { $status='FAIL';if($process.ExitCode -eq 0){$status='PASS'}; Check W01 install-exit $status INSTALLER_EXIT @{actual=$true;pid=$process.Id} $process.ExitCode }
    if ($process.ExitCode -ne 0) { throw 'INSTALL_FAILED' }
    foreach ($name in @('WhaleBridge.exe','WhaleBridgeCore.exe','resources/desktop-ui/index.html','build-info.json')) { if (-not (Test-Path -LiteralPath (OwnedPath "installed/$name") -PathType Leaf)) { throw 'INSTALLED_FILE_MISSING' } }
    if ((Get-FileHash -LiteralPath (OwnedPath 'installed/WhaleBridgeCore.exe')).Hash -ne (Get-FileHash -LiteralPath (OwnedPath 'input/payload/WhaleBridgeCore.exe')).Hash) { throw 'INSTALLED_CORE_HASH_MISMATCH' }
    $build = Get-Content -LiteralPath (OwnedPath 'installed/build-info.json') -Raw | ConvertFrom-Json
    if ($build.commit -ne $r.artifact.buildCommit) { throw 'BUILD_COMMIT_MISMATCH' }
    $installed = $true
    if ($r.packIds -contains 'W01') {
      Check W01 installed-files PASS OBSERVED @{actual=$true;coreSha256=(Get-FileHash -LiteralPath (OwnedPath 'installed/WhaleBridgeCore.exe')).Hash}
      Check W01 build-info PASS OBSERVED @{actual=$true;commit=$build.commit;version=$build.version}
    }
    if (($r.packIds -contains 'W04') -or ($r.packIds -contains 'W06') -or ($r.packIds -contains 'W05')) { . (OwnedPath 'runner/guest-core.ps1'); Invoke-CoreChecks }
    if (($r.packIds -contains 'W02') -or ($r.packIds -contains 'W03')) {
      # PowerShell Direct has no desktop. Only an existing disposable interactive token is used.
      $users = @(Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object {$_.SessionId -gt 0} | Select-Object -ExpandProperty UserName -Unique)
      if ($users.Count -eq 1) { $uiSessionPrepared=$true
        $taskName = "CetaMeshEnvironment-$run"
        $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -File $root\runner\guest-ui.ps1 -RequestFile $RequestFile"
        $principal = New-ScheduledTaskPrincipal -UserId $users[0] -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromMilliseconds([Math]::Max(1000,$deadline-(Now))))
        try {
          Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
          Start-ScheduledTask -TaskName $taskName; $uiDispatched=$true
          $uiResult=OwnedPath 'evidence/ui-result.json'
          while ((Now) -lt $deadline -and -not (Test-Path -LiteralPath $uiResult)) { Start-Sleep -Milliseconds 250 }
          if (Test-Path -LiteralPath $uiResult) { foreach ($check in @((Get-Content -LiteralPath $uiResult -Raw | ConvertFrom-Json).checks)) { $checks.Add($check) } }
        } finally { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
      }
    }
  }
    if ($installed -and ($r.packIds -contains 'W07')) {
      $uninstallArgs = @('--uninstall') + @($installArgs | Select-Object -Skip 1)
      $uninstaller = Start-Process -FilePath $installer -ArgumentList $uninstallArgs -WindowStyle Hidden -PassThru
      if (-not $uninstaller.WaitForExit([int][Math]::Max(1,[Math]::Min(60000,$deadline-(Now))))) { $uninstaller.Kill(); $null=$uninstaller.WaitForExit(5000); throw 'UNINSTALL_TIMEOUT_UNKNOWN_OUTCOME' }
      $uninstaller.Refresh()
      if ($uninstaller.ExitCode -ne 0 -or (Test-Path -LiteralPath (OwnedPath 'installed/WhaleBridgeCore.exe'))) { throw 'UNINSTALL_FAILED' }
      Check W07 uninstall PASS OBSERVED @{actual=$true;coreRemoved=$true;pid=$uninstaller.Id} $uninstaller.ExitCode
    }
} catch {
  # Only fixed error codes leave the Guest; command output may contain credentials.
  $failure = 'GUEST_OPERATION_UNCLASSIFIED'
  if ($_.Exception.Message -match '^[A-Z][A-Z0-9_]+$') { $failure = $_.Exception.Message }
  $failureStatus=Get-GuestFailureStatus $failure
  foreach ($pack in $r.packIds) { foreach ($id in $definitions[$pack]) { if ($pack -eq 'W05' -and $id -eq 'real-provider') { continue }; if (-not @($checks | Where-Object {$_.packId -eq $pack -and $_.id -eq $id}).Count) { Check $pack $id $failureStatus $failure } } }
}
foreach ($pack in $r.packIds) {
  foreach ($id in $definitions[$pack]) {
    if (@($checks | Where-Object {$_.packId -eq $pack -and $_.id -eq $id}).Count) { continue }
    $status='INCONCLUSIVE'; $code='GUEST_PROBE_EVIDENCE_MISSING'
    if ($r.mode -eq 'lifecycle-fixture') { $status='NOT_RUN'; $code='LIFECYCLE_FIXTURE_ONLY' }
    elseif ($pack -eq 'W05' -and $id -eq 'real-provider') { $status='NOT_RUN'; $code='REAL_PROVIDER_NOT_CONFIGURED' }
    elseif ($pack -eq 'W07') { $status='BLOCKED_ENV'; $code='PREVIOUS_CANDIDATE_NOT_CONFIGURED' }
    elseif ($pack -in @('W02','W03')) { if(-not $uiSessionPrepared){$status='BLOCKED_ENV';$code='INTERACTIVE_SESSION_MISSING'}else{$status='INCONCLUSIVE';$code='UI_RESULT_MISSING'} }
    Check $pack $id $status $code
  }
}
$observedEvidence=@(Get-ChildItem -LiteralPath $evidenceDir -File | Where-Object {$_.Name -notin @('report.json','manifest.json')} | ForEach-Object { $kind='log';if($_.Extension -eq '.png'){$kind='screenshot'};@{path=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant();bytes=$_.Length;kind=$kind} })
$report = @{schemaVersion=1;runId=$run;environmentId=$environment;taskId=$b.taskId;attemptId=$b.attemptId;guest=@{windowsBuild=[Environment]::OSVersion.Version.Build.ToString();architecture=$env:PROCESSOR_ARCHITECTURE};startedAt=$started;endedAt=(Now);checks=@($checks.ToArray());evidence=$observedEvidence}
$utf8=New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((OwnedPath 'evidence/report.json'),($report | ConvertTo-Json -Depth 16),$utf8)
$inventory=@(Get-ChildItem -LiteralPath $evidenceDir -File | ForEach-Object { @{path=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant();bytes=$_.Length;kind='report'} })
if ($inventory.Count -gt $b.limits.maxEvidenceFiles -or ($inventory | Measure-Object bytes -Sum).Sum -gt $b.limits.maxEvidenceBytes) { throw 'EVIDENCE_LIMIT' }
[IO.File]::WriteAllText((OwnedPath 'evidence/manifest.json'),(@{version=1;runId=$run;environmentId=$environment;files=$inventory}|ConvertTo-Json -Depth 8),$utf8)
