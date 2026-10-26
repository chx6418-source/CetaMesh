# Fixed operations only. JSON on stdin is data, never evaluated as PowerShell.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8=New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
$OutputEncoding=$utf8
function Assert-Path([string]$Root,[string]$Target) {
 $r=[IO.Path]::GetFullPath($Root).TrimEnd('\')
 $t=[IO.Path]::GetFullPath($Target)
 if(-not $t.StartsWith($r+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'PATH_ESCAPE'}
 $cursor=$t
 while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'REPARSE_POINT'}};$next=[IO.Path]::GetDirectoryName($cursor);if($next -eq $cursor){break};$cursor=$next}
 return $t
}
function Assert-Acl([string]$Target) {
 $cursor=[IO.Path]::GetFullPath($Target)
 $leaf=$true
 while($cursor){
  $item=Get-Item -LiteralPath $cursor -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'UNSAFE_PRIVILEGED_REPARSE'}
  $acl=Get-Acl -LiteralPath $cursor
  $owner=if($acl.Owner -match '^S-1-'){$acl.Owner}else{([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value}
  if($owner -notin @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')){throw 'UNSAFE_PRIVILEGED_OWNER'}
  foreach($rule in $acl.Access){
   $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
   if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $(if($leaf){852310}else{852032})) -and $sid -notin @('S-1-5-18','S-1-5-32-544')){throw 'UNSAFE_PRIVILEGED_ACL'}
  }
  $next=[IO.Path]::GetDirectoryName($cursor.TrimEnd('\'));if($next -eq $cursor){break};$cursor=$next;$leaf=$false
 }
}
function Inspect-Owned($p) {
 $r=$p.resources
 $expected=Assert-Path $p.hostRoot (Join-Path $p.hostRoot ('runs\'+$p.binding.runId+'\vm'))
 if($r.vmDirectory -ne $expected -or $r.diskPath -ne (Join-Path $expected 'guest.vhdx') -or $r.runId -ne $p.binding.runId -or $r.environmentId -ne $p.binding.environmentId){throw 'OWNERSHIP_PATH_MISMATCH'}
 [void](Assert-Path $p.hostRoot $r.diskPath)
 $vm=Get-VM -Id ([guid]$r.vmId) -ErrorAction Stop
 if($vm.Name -ne $r.vmName -or $vm.Notes -ne ('CetaMesh:'+ $r.ownerNonce+':'+$r.runId+':'+$r.environmentId)){throw 'OWNERSHIP_NONCE_MISMATCH'}
 if($vm.Path.TrimEnd('\') -ne $r.vmDirectory.TrimEnd('\')){throw 'VM_PATH_MISMATCH'}
 $disks=@(Get-VMHardDiskDrive -VM $vm)
 if($disks.Count -ne 1 -or $disks[0].Path -ne $r.diskPath){throw 'DISK_OWNERSHIP_MISMATCH'}
 $vhd=Get-VHD -Path $r.diskPath
 if($vhd.ParentPath -or $vhd.VhdType -ne 'Fixed' -or $vhd.Size -gt ([long]$p.profile.limits.diskGiB*1GB) -or $vhd.FileSize -gt ([long]$p.profile.limits.diskGiB*1GB+64MB)){throw 'DISK_CHAIN_MISMATCH'}
 if(@(Get-VMSnapshot -VM $vm).Count -ne 0 -or @(Get-VMNetworkAdapter -VM $vm).Count -ne 0){throw 'VM_ISOLATION_CHANGED'}
 return $vm
}
function Run-Operation($p) {
 $op=[string]$p.operation
 if($op -eq 'preflight'){
  $reasons=@();$observations=[ordered]@{}
  $moduleAvailable=[bool](Get-Command Get-VM -ErrorAction SilentlyContinue)
  $vmms=Get-Service vmms -ErrorAction SilentlyContinue
  $observations.hyperv=@{moduleAvailable=$moduleAvailable;servicePresent=[bool]$vmms;serviceStatus=$(if($vmms){$vmms.Status.ToString()}else{'Missing'})}
  if(-not $moduleAvailable){$reasons+='HYPERV_MODULE_MISSING'}
  if(-not $vmms){$reasons+='VMMS_MISSING'}elseif($vmms.Status -ne 'Running'){$reasons+='VMMS_NOT_RUNNING'}
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $elevated=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $observations.permissions=@{elevated=$elevated;trustedAcl='NOT_CHECKED'}
  if(-not $elevated){$reasons+='ELEVATED_OWNER_HOST_REQUIRED'}
  $observations.os=@{edition=$null;build=$null;version=$null;architecture=$null;sku=$null}
  $observations.memory=@{availableBytes=$null;totalBytes=$null;hostReserveBytes=2GB;requiredGuestBytes=$(if($p.profile){[long]$p.profile.limits.memoryMiB*1MB}else{$null})}
  try{
   $os=Get-CimInstance Win32_OperatingSystem
   $observations.os=@{edition=[string]$os.Caption;build=[string]$os.BuildNumber;version=[string]$os.Version;architecture=[string]$os.OSArchitecture;sku=$os.OperatingSystemSKU}
   $observations.memory.availableBytes=[long]$os.FreePhysicalMemory*1KB
   $observations.memory.totalBytes=[long]$os.TotalVisibleMemorySize*1KB
   if($p.profile -and $observations.memory.availableBytes -lt ([long]$p.profile.limits.memoryMiB*1MB+2GB)){$reasons+='MEMORY_RESERVE_MISSING'}
  }catch{$reasons+='OS_RESOURCE_QUERY_UNAVAILABLE'}
  $observations.virtualization=@{status='UNKNOWN';hypervisorPresent=$null;firmwareEnabled=$null;slatAvailable=$null;monitorModeAvailable=$null;processorCount=$null}
  try{
   $computer=Get-CimInstance Win32_ComputerSystem
   $cpus=@(Get-CimInstance Win32_Processor)
   $firmware=$cpus.Count -gt 0 -and @($cpus | Where-Object {$_.VirtualizationFirmwareEnabled -ne $true}).Count -eq 0
   $slat=$cpus.Count -gt 0 -and @($cpus | Where-Object {$_.SecondLevelAddressTranslationExtensions -ne $true}).Count -eq 0
   $monitor=$cpus.Count -gt 0 -and @($cpus | Where-Object {$_.VMMonitorModeExtensions -ne $true}).Count -eq 0
   $observations.virtualization=@{status='UNKNOWN';hypervisorPresent=[bool]$computer.HypervisorPresent;firmwareEnabled=$firmware;slatAvailable=$slat;monitorModeAvailable=$monitor;processorCount=$computer.NumberOfLogicalProcessors}
   if($computer.HypervisorPresent){$observations.virtualization.status='MASKED_BY_HYPERVISOR'}
   elseif($firmware -and $slat -and $monitor){$observations.virtualization.status='SUPPORTED'}
   elseif($cpus.Count -and @($cpus | Where-Object {$null -eq $_.VirtualizationFirmwareEnabled -or $null -eq $_.SecondLevelAddressTranslationExtensions -or $null -eq $_.VMMonitorModeExtensions}).Count -eq 0){$observations.virtualization.status='UNSUPPORTED';$reasons+='CPU_VIRTUALIZATION_UNAVAILABLE'}
   else{$reasons+='CPU_VIRTUALIZATION_UNKNOWN'}
  }catch{$reasons+='CPU_VIRTUALIZATION_UNKNOWN'}
  $observations.storage=@{availableBytes=$null;requiredBytes=$null}
  try{
   $volume=if($p.hostRoot){[IO.Path]::GetPathRoot($p.hostRoot)}else{$env:SystemDrive+'\'}
   $drive=New-Object IO.DriveInfo($volume)
   $observations.storage.availableBytes=[long]$drive.AvailableFreeSpace
   if($p.profile){$reserve=[long]$p.profile.limits.diskGiB*1GB+[long]$p.profile.limits.memoryMiB*1MB+[long]$p.profile.limits.maxEvidenceBytes+128MB;$observations.storage.requiredBytes=$reserve;if($observations.storage.availableBytes -lt $reserve){$reasons+='DISK_RESERVE_MISSING'}}
  }catch{$reasons+='DISK_RESOURCE_QUERY_UNAVAILABLE'}
  $observations.network=@{requestedMode='offline';guestAdapterCount=0;hostSwitchCount=$null;changesRequired=$false;queryStatus='NOT_AVAILABLE'}
  $observations.existingResources=@{vmCount=$null;ownedVmCount=$null;requestedIdentityConflict=$null;queryStatus='NOT_AVAILABLE'}
  if($moduleAvailable){
   try{$observations.network.hostSwitchCount=@(Get-VMSwitch).Count;$observations.network.queryStatus='OBSERVED'}catch{$observations.network.queryStatus='UNKNOWN'}
   try{
    $existing=@(Get-VM);$owned=@($existing | Where-Object {$_.Notes -like 'CetaMesh:*'})
    $conflict=$false;if($p.binding){$conflict=@($existing | Where-Object {$_.Name -eq ('CetaMesh-'+$p.binding.environmentId)}).Count -gt 0}
    $observations.existingResources=@{vmCount=$existing.Count;ownedVmCount=$owned.Count;requestedIdentityConflict=$conflict;queryStatus='OBSERVED'}
    if($conflict){$reasons+='VM_IDENTITY_CONFLICT'}
    if($owned.Count -gt 0){$reasons+='OWNED_RESOURCE_REQUIRES_RECONCILIATION'}
   }catch{$observations.existingResources.queryStatus='UNKNOWN';$reasons+='VM_RESOURCE_QUERY_UNAVAILABLE'}
  }
  $observations.image=@{configured=[bool]$p.profile;exists=$false;virtualBytes=$null;hasParent=$null;withinQuota=$null;queryStatus='NOT_CONFIGURED'}
  if($p.profile){
   try{Assert-Acl $p.hostRoot;Assert-Acl $p.scriptRoot;Assert-Acl $p.profile.image.path;Assert-Acl $p.profile.guestCredentialFile;$observations.permissions.trustedAcl='VERIFIED'}catch{$observations.permissions.trustedAcl='UNSAFE_OR_MISSING';$reasons+='TRUSTED_ACL_OR_INPUT_MISSING'}
   $observations.image.exists=Test-Path -LiteralPath $p.profile.image.path -PathType Leaf
   if(-not $observations.image.exists){$observations.image.queryStatus='MISSING';$reasons+='APPROVED_IMAGE_MISSING'}
   elseif($moduleAvailable){
    try{$base=Get-VHD -Path $p.profile.image.path;$observations.image.virtualBytes=[long]$base.Size;$observations.image.hasParent=[bool]$base.ParentPath;$observations.image.withinQuota=$base.Size -le ([long]$p.profile.limits.diskGiB*1GB);$observations.image.queryStatus='OBSERVED';if($base.ParentPath){$reasons+='BASE_DISK_CHAIN_UNSUPPORTED'};if(-not $observations.image.withinQuota){$reasons+='BASE_DISK_QUOTA_EXCEEDED'}}catch{$observations.image.queryStatus='UNKNOWN';$reasons+='BASE_DISK_QUERY_UNAVAILABLE'}
   }else{$observations.image.queryStatus='HYPERV_UNAVAILABLE'}
  }else{$reasons+='APPROVED_PROFILE_REQUIRED'}
  $status='PASS';if($reasons.Count){$status='BLOCKED_ENV'}
  return @{status=$status;reasons=$reasons;readOnly=$true;observations=$observations}
 }
 if($op -notin @('prepare','inspect','start','stop','destroyOwned','copyIn','exec','copyOut','capture')){throw 'OPERATION_DENIED'}
 Assert-Acl $p.hostRoot;Assert-Acl $p.scriptRoot
 if($op -eq 'prepare'){
  $pre=Run-Operation ([pscustomobject]@{operation='preflight';hostRoot=$p.hostRoot;scriptRoot=$p.scriptRoot;profile=$p.profile})
  if($pre.status -ne 'PASS'){throw 'BLOCKED_ENV'}
  $r=$p.resources
  [void](Assert-Path $p.hostRoot $r.vmDirectory);[void](Assert-Path $p.hostRoot $r.diskPath)
  if(Test-Path -LiteralPath $r.vmDirectory){throw 'EXISTING_DIRECTORY'}
  $base=Get-VHD -Path $p.profile.image.path
  if($base.ParentPath -or $base.Size -gt ([long]$p.profile.limits.diskGiB*1GB)){throw 'BASE_DISK_QUOTA_OR_CHAIN'}
  if((Get-FileHash -LiteralPath $p.profile.image.path -Algorithm SHA256).Hash -ne $p.profile.image.sha256){throw 'BASE_HASH_MISMATCH'}
  New-Item -ItemType Directory -Path $r.vmDirectory | Out-Null
  Convert-VHD -Path $p.profile.image.path -DestinationPath $r.diskPath -VHDType Fixed | Out-Null
  $vm=New-VM -Name $r.vmName -Generation 2 -Path $r.vmDirectory -MemoryStartupBytes ([long]$p.profile.limits.memoryMiB*1MB) -VHDPath $r.diskPath
  # A crash before these markers remains quarantined; no name-based recovery/delete.
  Set-VM -VM $vm -Notes ('CetaMesh:'+$r.ownerNonce+':'+$r.runId+':'+$r.environmentId) -CheckpointType Disabled -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction TurnOff
  Set-VMProcessor -VM $vm -Count $p.profile.limits.cpuCount
  Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
  Get-VMNetworkAdapter -VM $vm | Remove-VMNetworkAdapter
  $r.vmId=$vm.Id.ToString()
  [void](Inspect-Owned $p)
  return $r
 }
 $vm=Inspect-Owned $p
 if($op -eq 'inspect'){return @{owned=$true;state=$vm.State.ToString()}}
 if($op -eq 'start'){Start-VM -VM $vm | Out-Null;return @{status='PASS';state=(Get-VM -Id $vm.Id).State.ToString()}}
 if($op -eq 'stop'){if($vm.State -ne 'Off'){Stop-VM -VM $vm -TurnOff -Force};$after=Inspect-Owned $p;if($after.State -ne 'Off'){throw 'STOP_UNKNOWN'};return @{owned=$true;state='Off'}}
 if($op -eq 'destroyOwned'){
  if($vm.State -ne 'Off' -or $p.evidenceReceipt.verified -ne $true -or $p.evidenceReceipt.runId -ne $p.binding.runId -or $p.evidenceReceipt.environmentId -ne $p.binding.environmentId){throw 'CLEANUP_DENIED'}
  $target=Assert-Path $p.hostRoot $p.resources.vmDirectory
  # Pre-enumerate every child to reject junctions before any recursive removal.
  Get-ChildItem -LiteralPath $target -Recurse -Force | ForEach-Object {[void](Assert-Path $p.hostRoot $_.FullName)}
  Remove-VM -VM $vm -Force
  if(Get-VM -Id ([guid]$p.resources.vmId) -ErrorAction SilentlyContinue){throw 'REMOVE_UNKNOWN'}
  Remove-Item -LiteralPath $target -Recurse -Force
  if((Get-VM -Id ([guid]$p.resources.vmId) -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $target)){throw 'REMOVE_UNKNOWN'}
  return @{status='PASS';removed=$true;vmAbsent=$true;directoryAbsent=$true}
 }
 $credential=Import-Clixml -LiteralPath $p.profile.guestCredentialFile
 if($credential -isnot [Management.Automation.PSCredential]){throw 'INVALID_GUEST_CREDENTIAL'}
 $session=New-PSSession -VMId $vm.Id -Credential $credential
 try {
  $guestRoot='C:\CetaMeshEnv\'+$p.binding.runId
  if($op -eq 'copyIn'){
   Invoke-Command -Session $session -ArgumentList $guestRoot,$p.binding.runId,$p.binding.environmentId -ScriptBlock {param($root,$run,$envId)
    if(Test-Path -LiteralPath $root){throw 'GUEST_ROOT_EXISTS'}
    New-Item -ItemType Directory -Path ($root+'\input'),($root+'\runner') -Force | Out-Null
    @{version=1;runId=$run;environmentId=$envId;guestVmId=(Get-CimInstance Win32_ComputerSystemProduct).UUID} | ConvertTo-Json | Set-Content -LiteralPath ($root+'\guard.json') -Encoding UTF8
   }
   foreach($name in @('guest-runner.ps1','guest-ui.ps1','guest-core.ps1')){Copy-Item -LiteralPath (Join-Path $p.scriptRoot $name) -Destination ($guestRoot+'\runner\'+$name) -ToSession $session}
   foreach($f in $p.files){
    if($f.relativePath -notmatch '^input/[A-Za-z0-9_. /-]+$' -or $f.relativePath -match '(^|/)\.\.(/|$)'){throw 'INPUT_PATH_DENIED'}
    $dest=$guestRoot+'\'+$f.relativePath.Replace('/','\')
    Invoke-Command -Session $session -ArgumentList $dest -ScriptBlock {param($d) New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($d)) -Force | Out-Null}
    Copy-Item -LiteralPath $f.source -Destination $dest -ToSession $session
   };return @{status='PASS'}
  }
  if($op -eq 'exec'){
   if($p.guestRequest.guestRoot -ne $guestRoot -or $p.guestRequest.binding.runId -ne $p.binding.runId -or $p.guestRequest.binding.environmentId -ne $p.binding.environmentId){throw 'GUEST_REQUEST_MISMATCH'}
   $request=$p.guestRequest | ConvertTo-Json -Depth 30 -Compress
   return Invoke-Command -Session $session -ArgumentList $guestRoot,$request -ScriptBlock {param($root,$json)
    $file=$root+'\request.json';$json | Set-Content -LiteralPath $file -Encoding UTF8
    & ($root+'\runner\guest-runner.ps1') -RequestFile $file | Out-Null
    $report=Get-Content -LiteralPath ($root+'\evidence\report.json') -Raw | ConvertFrom-Json
    $manifest=Get-Content -LiteralPath ($root+'\evidence\manifest.json') -Raw | ConvertFrom-Json
    @{report=$report;evidenceManifest=$manifest}
   }
  }
  # Export is intentionally a separate bounded operation; no recursive guest copy.
  if($op -in @('copyOut','capture')){
   $inventory=@(Invoke-Command -Session $session -ArgumentList $guestRoot,$p.profile.limits.maxEvidenceFiles,$p.profile.limits.maxEvidenceBytes -ScriptBlock {param($root,$maxFiles,$maxBytes)
    $base=$root+'\evidence';$queue=New-Object 'Collections.Generic.Queue[string]';$queue.Enqueue($base);$files=@();$total=0L;$dirs=0
    while($queue.Count){$dir=$queue.Dequeue();$dirs++;if($dirs -gt $maxFiles){throw 'EVIDENCE_DIRECTORY_LIMIT'}
     if((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'EVIDENCE_LINK'}
     foreach($item in @(Get-ChildItem -LiteralPath $dir -Force)){
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'EVIDENCE_LINK'}
      if($item.PSIsContainer){$queue.Enqueue($item.FullName);continue}
      $total+=$item.Length;if($total -gt $maxBytes -or $files.Count -ge $maxFiles){throw 'EVIDENCE_LIMIT'}
      $rel=$item.FullName.Substring($base.Length+1).Replace('\','/')
      if($rel -notmatch '^[A-Za-z0-9_./-]+$' -or $rel -match '(^|/)\.\.(/|$)'){throw 'EVIDENCE_PATH'}
      $files+=@{path=$rel;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
     }
    };return $files
   })
   if($inventory.Count -gt $p.profile.limits.maxEvidenceFiles){throw 'EVIDENCE_FILE_LIMIT'}
   if($op -eq 'capture'){
    $reportPresent=@($inventory | Where-Object {$_.path -eq 'report.json'}).Count -eq 1
    if(-not $reportPresent){throw 'GUEST_REPORT_MISSING'}
    return @{status='PASS';runId=$p.binding.runId;environmentId=$p.binding.environmentId;reportPresent=$reportPresent;files=$inventory;screenshotCount=@($inventory | Where-Object {$_.path -match '\.(png|jpg|jpeg)$'}).Count;logCount=@($inventory | Where-Object {$_.path -match '\.(log|txt)$'}).Count;exported=$false}
   }
   $exportRoot=Assert-Path $p.hostRoot (Join-Path $p.hostRoot ('runs\'+$p.binding.runId+'\exports'))
   if(Test-Path -LiteralPath $exportRoot){throw 'EXPORT_EXISTS'}
   New-Item -ItemType Directory -Path $exportRoot | Out-Null
   $receipts=@();$total=0L
   foreach($f in $inventory){
    if($f.path -notmatch '^[A-Za-z0-9_./-]+$' -or $f.path -match '(^|/)\.\.(/|$)' -or $f.bytes -lt 0){throw 'EVIDENCE_PATH'}
    $total+=[long]$f.bytes;if($total -gt $p.profile.limits.maxEvidenceBytes){throw 'EVIDENCE_BYTE_LIMIT'}
    $dest=Assert-Path $exportRoot (Join-Path $exportRoot $f.path)
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($dest)) -Force | Out-Null
    $out=[IO.File]::Open($dest,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$offset=0L
     while($offset -lt [long]$f.bytes){
      $count=[int][Math]::Min(262144,[long]$f.bytes-$offset)
      $encoded=Invoke-Command -Session $session -ArgumentList $guestRoot,$f.path,$offset,$count,$f.bytes -ScriptBlock {param($root,$relative,$offset,$count,$expected)
       $file=$root+'\evidence\'+$relative.Replace('/','\');$cursor=$file
       while($cursor -and $cursor.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'EVIDENCE_LINK'};$cursor=[IO.Path]::GetDirectoryName($cursor)}
       $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
       try{if($stream.Length -ne $expected){throw 'EVIDENCE_CHANGED'};$stream.Position=$offset;$buffer=New-Object byte[] $count;$read=$stream.Read($buffer,0,$count);if($read -ne $count){throw 'EVIDENCE_TRUNCATED'};[Convert]::ToBase64String($buffer)}finally{$stream.Dispose()}
      }
      $chunk=[Convert]::FromBase64String($encoded);if($chunk.Length -ne $count){throw 'EVIDENCE_CHUNK'};$out.Write($chunk,0,$chunk.Length);$offset+=$chunk.Length
     };$out.Flush($true)
    }finally{$out.Dispose()}
    if((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -ne $f.sha256){throw 'EVIDENCE_HASH'}
    $receipts+=@{path=$f.path;relativePath=('runs/'+$p.binding.runId+'/exports/'+$f.path);sha256=$f.sha256;bytes=$f.bytes}
   }
   return @{version=1;runId=$p.binding.runId;environmentId=$p.binding.environmentId;files=$receipts;exportRoot=$exportRoot}
  }
 } finally {Remove-PSSession -Session $session}
}
try {
 $raw=[Console]::In.ReadToEnd()
 if($raw.Length -gt 2097152){throw 'INPUT_TOO_LARGE'}
 $payload=$raw | ConvertFrom-Json
 $result=Run-Operation $payload
 $result | ConvertTo-Json -Depth 40 -Compress
} catch {
 @{error=@{code='HYPERV_OPERATION_FAILED';message=$_.Exception.Message}} | ConvertTo-Json -Compress
 exit 1
}
