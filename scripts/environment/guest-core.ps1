# Pure classification only. Unknown driver/evidence errors are not product success or environment skips.
function Get-GuestFailureStatus([string]$Code) {
  if($Code -in @('UIA_DEPENDENCY_MISSING','INTERACTIVE_SESSION_MISSING','PREVIOUS_CANDIDATE_NOT_CONFIGURED')) { return 'BLOCKED_ENV' }
  if($Code -match 'UNKNOWN|^SCREENSHOT_|^UIA_PATTERN_|^UIA_TREE_|^UI_RESULT_|^GUEST_OPERATION_UNCLASSIFIED$') { return 'INCONCLUSIVE' }
  if($Code -match '^GUI_|^ONBOARDING_|^UIA_FLOW_TIMEOUT$|FAILED$|MISMATCH$|MISSING$|BYPASS$|REPLAYED$|ALLOWED$|NOT_ACCEPTED$|NOT_OBSERVED$|NOT_CONFIRMED$|NOT_PROPAGATED$|FALSE_COMPLETION$|LIMIT$|TIMEOUT$|^CANDIDATE_|^INSTALLED_') { return 'FAIL' }
  return 'INCONCLUSIVE'
}
# Loaded only after guest-runner's VM/path/expiry guards. No source Node surrogate.
function Invoke-CoreChecks {
  $pipeName = "CetaMeshEnvironment-$run"
  $tokenBytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($tokenBytes); $rng.Dispose()
  $token = ([BitConverter]::ToString($tokenBytes)).Replace('-','').ToLowerInvariant()
  $core = $null; $providerServer = $null
  function Start-OwnedCore {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = OwnedPath 'installed/WhaleBridgeCore.exe'
    $psi.Arguments = "--worker --data-dir $(OwnedPath 'core-data')"
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true
    $psi.EnvironmentVariables['WHALEBRIDGE_UI_PIPE'] = "\\.\pipe\$pipeName"
    $psi.EnvironmentVariables['WHALEBRIDGE_UI_AUTH_TOKEN'] = $token
    $psi.EnvironmentVariables['WHALEBRIDGE_DATA_DIR'] = OwnedPath 'core-data'
    return [Diagnostics.Process]::Start($psi)
  }
  function Read-Exact($stream,[int]$count) {
    $buffer = New-Object byte[] $count
    $offset=0
    while ($offset -lt $count) {
      if((Now) -ge $deadline){throw 'IPC_TIMEOUT'}
      $pending=$stream.BeginRead($buffer,$offset,$count-$offset,$null,$null)
      if (-not $pending.AsyncWaitHandle.WaitOne([int][Math]::Max(1,[Math]::Min(5000,$deadline-(Now))))) { $stream.Dispose();throw 'IPC_TIMEOUT' }
      $read=$stream.EndRead($pending)
      if($read -le 0){throw 'IPC_EOF'}
      $offset += $read
    }
    return ,$buffer
  }
  function Call-Core([string]$method,$parameters=@{},[bool]$badToken=$false) {
    if ($method -notin @('core.ping','task.create','task.get','memory.list','workspace.list','task.environment-invalid','workspace.create','providers.secrets.set','task.child.create','capability.execute','ui.task.cancel')) {throw 'GUEST_METHOD_NOT_ALLOWED'}
    $client = New-Object IO.Pipes.NamedPipeClientStream('.', $pipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try {
      $client.Connect([int][Math]::Max(1,[Math]::Min(10000,$deadline-(Now))))
      $auth=$token; if($badToken){$auth='0'*64}
      $id=[guid]::NewGuid().ToString()
      $request=@{version=1;id=$id;method=$method;params=$parameters;role='console';authToken=$auth}|ConvertTo-Json -Depth 10 -Compress
      $bytes=[Text.Encoding]::UTF8.GetBytes($request)
      $header=[BitConverter]::GetBytes([uint32]$bytes.Length)
      $client.Write($header,0,4);$client.Write($bytes,0,$bytes.Length);$client.Flush()
      # Production sends exactly one unsolicited ready frame before the response.
      # Bound frames and accept only that explicit event, never arbitrary notifications.
      $readySeen=$false
      for($frameIndex=0;$frameIndex -lt 2;$frameIndex++) {
        $length=[BitConverter]::ToUInt32((Read-Exact $client 4),0)
        if($length -lt 1 -or $length -gt 1048576){throw 'IPC_FRAME_LIMIT'}
        $response=[Text.Encoding]::UTF8.GetString((Read-Exact $client $length))|ConvertFrom-Json
        if($null -eq $response){throw 'IPC_RESPONSE_IDENTITY'}
        $properties=@($response.PSObject.Properties.Name)
        if($properties -notcontains 'version' -or $response.version -ne 1){throw 'IPC_RESPONSE_IDENTITY'}
        if($properties -contains 'event') {
          if($readySeen -or $frameIndex -ne 0 -or $response.event -ne 'core.ready' -or $properties.Count -ne 2){throw 'IPC_UNEXPECTED_EVENT'}
          $readySeen=$true;continue
        }
        if($properties -notcontains 'id' -or $properties -notcontains 'ok' -or $response.id -ne $id -or $response.ok -isnot [bool]){throw 'IPC_RESPONSE_IDENTITY'}
        return $response
      }
      throw 'IPC_RESPONSE_MISSING'
    } finally {$client.Dispose()}
  }
  try {
    $core=Start-OwnedCore
    $ping=Call-Core 'core.ping'
    if(-not $ping.ok -or $ping.result.status -ne 'pong'){throw 'CORE_PING_FAILED'}
    if($r.packIds -contains 'W04') {
      Check W04 core-ipc PASS OBSERVED @{actual=$true;pid=$core.Id;binary='WhaleBridgeCore.exe';framing='v1-length-prefixed'}
      foreach($probe in @(@('memory','memory.list'),@('workspace','workspace.list'))) {
        $reply=Call-Core $probe[1]
        if(-not $reply.ok){throw 'CORE_READ_FAILED'}
        Check W04 $probe[0] PASS OBSERVED @{actual=$true;method=$probe[1];responseReceived=$true}
      }
      $denied=Call-Core 'core.ping' @{} $true
      if($denied.ok -or $denied.error.code -ne 'IPC_AUTH_DENIED'){throw 'IPC_PERMISSION_BYPASS'}
      Check W04 permission PASS OBSERVED @{actual=$true;rejectedCode=$denied.error.code}
      $unknown=Call-Core 'task.environment-invalid'
      if($unknown.ok -or -not $unknown.error.code){throw 'IPC_ERROR_NOT_SURFACED'}
      Check W04 error PASS OBSERVED @{actual=$true;errorCode=$unknown.error.code}
    }
    # Use the existing built-in CetaMesh Agent with a held loopback model request.
    # Read-only children are the production path that records authoritative Attempts.
    $ready=OwnedPath 'provider.ready';$inference=OwnedPath 'provider.inference'
    $toolProof=OwnedPath 'provider.tool-proof.json';$cancelProof=OwnedPath 'provider.cancelled';$fixtureText="environment-read-$run"
    $providerServer=Start-Job -ArgumentList $ready,$inference,$deadline,$toolProof,$cancelProof,$fixtureText -ScriptBlock {
      param($readyPath,$inferencePath,$end,$proofPath,$cancelPath,$expectedText)
      $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,19390)
      $listener.Start();[IO.File]::WriteAllText($readyPath,'ready')
      try { while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $end) {
        if(-not $listener.Pending()){Start-Sleep -Milliseconds 100;continue}
        $client=$listener.AcceptTcpClient();$stream=$client.GetStream();$stream.ReadTimeout=5000
        try {
          # Bounded wire parser; never persist prompts, keys or raw request bodies.
          $headerBytes=New-Object 'Collections.Generic.List[byte]'
          do {
            $value=$stream.ReadByte();if($value -lt 0){throw 'FIXTURE_EOF'};$headerBytes.Add([byte]$value)
            if($headerBytes.Count -gt 16384){throw 'FIXTURE_HEADER_LIMIT'}
            $tail=[Text.Encoding]::ASCII.GetString($headerBytes.ToArray())
          } while(-not $tail.EndsWith("`r`n`r`n"))
          $line=($tail -split "`r`n")[0]
          $length=0;if($tail -match '(?im)^Content-Length:\s*(\d+)'){$length=[int]$Matches[1]}
          if($length -gt 1048576){throw 'FIXTURE_BODY_LIMIT'}
          $payload=New-Object byte[] $length;$offset=0
          while($offset -lt $length){$n=$stream.Read($payload,$offset,$length-$offset);if($n -le 0){throw 'FIXTURE_BODY_EOF'};$offset+=$n}
          $responseBody=$null;$contentType='application/json'
          if($line -match '^POST /v1/chat/completions ') {
            $request=[Text.Encoding]::UTF8.GetString($payload)|ConvertFrom-Json
            if($request.model -eq 'environment-tools') {
              $results=@($request.messages | Where-Object {$_.role -eq 'tool'})
              if($results.Count -eq 0) {
                if(-not @($request.tools | Where-Object {$_.function.name -eq 'cap_filesystem_read'}).Count){throw 'READ_TOOL_NOT_ADVERTISED'}
                $chunk=@{id='fixture-tool';model='environment-tools';choices=@(@{index=0;delta=@{tool_calls=@(@{index=0;id='environment-read-1';type='function';function=@{name='cap_filesystem_read';arguments='{"path":"fixture.txt"}'}})};finish_reason='tool_calls'})}|ConvertTo-Json -Depth 12 -Compress
                $responseBody="data: $chunk`n`ndata: [DONE]`n`n";$contentType='text/event-stream'
              } else {
                $result=$results[-1]
                $assistant=@($request.messages | Where-Object {$_.role -eq 'assistant' -and ($_.PSObject.Properties.Name -contains 'tool_calls')})
                $original=@($assistant | ForEach-Object {$_.tool_calls} | Where-Object {$_.id -eq 'environment-read-1'})
                if($result.tool_call_id -ne 'environment-read-1' -or $original.Count -ne 1 -or -not $result.content.Contains($expectedText)){throw 'ACTUAL_TOOL_RESULT_MISMATCH'}
                [IO.File]::WriteAllText($proofPath,(@{callId='environment-read-1';resultMatched=$true;rounds=2;actualContentObserved=$true}|ConvertTo-Json -Compress))
                while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $end){
                  if($client.Client.Poll(100000,[Net.Sockets.SelectMode]::SelectRead) -and $client.Client.Available -eq 0){[IO.File]::WriteAllText($cancelPath,(@{closedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress));break}
                  Start-Sleep -Milliseconds 100
                }
              }
            } else {
              [IO.File]::WriteAllText($inferencePath,'inference-request-observed')
              while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $end){Start-Sleep -Milliseconds 100}
            }
          } elseif($line -match '^GET /v1/models ') {
            $responseBody='{"object":"list","data":[{"id":"environment-fixture","object":"model"},{"id":"environment-tools","object":"model"}]}'
          } else {throw 'UNEXPECTED_FIXTURE_ENDPOINT'}
          if($null -ne $responseBody){
            $bytes=[Text.Encoding]::UTF8.GetBytes($responseBody)
            $head=[Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
            $stream.Write($head,0,$head.Length);$stream.Write($bytes,0,$bytes.Length)
          }
        } finally {$client.Dispose()}
      }} finally {$listener.Stop()}
    }
    $readyDeadline=[Math]::Min($deadline,(Now)+10000)
    while(-not (Test-Path -LiteralPath $ready) -and (Now) -lt $readyDeadline){Start-Sleep -Milliseconds 100}
    if(-not (Test-Path -LiteralPath $ready)){throw 'MODEL_FIXTURE_START_FAILED'}
    $configured=Call-Core 'providers.secrets.set' @{provider='openai';apiKey='environment-synthetic-key';baseUrl='http://127.0.0.1:19390/v1'}
    if(-not $configured.ok){throw 'MODEL_FIXTURE_CONFIGURATION_FAILED'}
    $workspace=Call-Core 'workspace.create' @{name='Environment fixture';root=(OwnedPath 'workspace');createIfMissing=$true}
    if(-not $workspace.ok){throw 'WORKSPACE_CREATE_FAILED'}
    $workspaceId=$workspace.result.workspace.id
    [IO.File]::WriteAllText((OwnedPath 'workspace/fixture.txt'),$fixtureText)
    $created=Call-Core 'task.create' @{goal='Disposable environment persistence parent';requestId="environment-$run";workspaceId=$workspaceId}
    if(-not $created.ok){throw 'TASK_CREATE_FAILED'}
    $parent=$created.result
    if($r.packIds -contains 'W05') {
      $toolChild=Call-Core 'task.child.create' @{parentTaskId=$parent.id;expectedParentRev=$parent.rev;requestId="tool-child-$run";goal='Read fixture.txt through the allowed tool';workspaceId=$workspaceId;contract=@{mode='read-only';outputKind='analysis';readScope=@('fixture.txt');expectedEvidence=@('Observe actual read result')}}
      if(-not $toolChild.ok){throw 'TOOL_CHILD_CREATE_FAILED'}
      $toolTaskId=$toolChild.result.id
      $toolDispatch=Call-Core 'capability.execute' @{requestId="tool-attempt-$run";capability='agent.run';taskId=$toolTaskId;workspaceId=$workspaceId;input=@{agentProvider='cetamesh';modelProvider='openai';model='environment-tools';content='Read fixture.txt using filesystem.read and inspect the actual tool result.'}}
      if(-not $toolDispatch.ok -or $toolDispatch.result.status -ne 'completed'){throw 'TOOL_AGENT_DISPATCH_FAILED'}
      $toolDeadline=[Math]::Min($deadline,(Now)+20000)
      while(-not (Test-Path -LiteralPath $toolProof) -and (Now) -lt $toolDeadline){Start-Sleep -Milliseconds 100}
      if(-not (Test-Path -LiteralPath $toolProof)){throw 'TOOL_ROUNDTRIP_NOT_OBSERVED'}
      $proof=Get-Content -LiteralPath $toolProof -Raw|ConvertFrom-Json
      if(-not $proof.resultMatched -or -not $proof.actualContentObserved -or $proof.rounds -ne 2){throw 'TOOL_ROUNDTRIP_INVALID'}
      Check W05 managed-tool-roundtrip PASS OBSERVED @{actual=$true;capability='filesystem.read';callId=$proof.callId;resultMatched=$true;rounds=2;actualContentObserved=$true;provider='synthetic-loopback'}
      $toolState=Call-Core 'task.get' @{id=$toolTaskId}
      if(-not $toolState.ok -or $toolState.result.task.status -ne 'running'){throw 'TASK_FALSE_COMPLETION'}
      $execution=@($toolState.result.task.executionEvidence|Where-Object {$_.capability -eq 'filesystem.read' -and $_.status -eq 'completed'})
      if($execution.Count -lt 1 -or [string]::IsNullOrWhiteSpace($toolState.result.task.progress.note)){throw 'TASK_TOOL_PROGRESS_MISSING'}
      Check W05 task-progress PASS OBSERVED @{actual=$true;taskId=$toolTaskId;taskStatus='running';executionEvidence=$execution.Count;progressObserved=$true;completed=$false}
      $cancelRequestedAt=Now
      $cancelled=Call-Core 'ui.task.cancel' @{id=$toolTaskId;reason='Guest controlled cancellation probe'}
      if(-not $cancelled.ok -or $cancelled.result.task.status -ne 'cancelled'){throw 'TASK_CANCEL_NOT_CONFIRMED'}
      $cancelDeadline=[Math]::Min($deadline,(Now)+10000)
      while(-not (Test-Path -LiteralPath $cancelProof) -and (Now) -lt $cancelDeadline){Start-Sleep -Milliseconds 100}
      if(-not (Test-Path -LiteralPath $cancelProof)){throw 'MODEL_CANCEL_NOT_PROPAGATED'}
      $closure=Get-Content -LiteralPath $cancelProof -Raw|ConvertFrom-Json
      if($closure.closedAt -lt $cancelRequestedAt){throw 'MODEL_CLOSED_BEFORE_CANCELLATION'}
      Check W05 cancel-propagation PASS OBSERVED @{actual=$true;taskId=$toolTaskId;taskStatus='cancelled';modelConnectionClosed=$true;cancelRequestedAt=$cancelRequestedAt;connectionClosedAt=$closure.closedAt}
      $parentRead=Call-Core 'task.get' @{id=$parent.id};if(-not $parentRead.ok){throw 'PARENT_READ_FAILED'};$parent=$parentRead.result.task
    }
    $childReply=Call-Core 'task.child.create' @{parentTaskId=$parent.id;expectedParentRev=$parent.rev;requestId="child-$run";goal='Read fixture.txt and report analysis';workspaceId=$workspaceId;contract=@{mode='read-only';outputKind='analysis';readScope=@('fixture.txt');expectedEvidence=@('Read-only analysis report')}}
    if(-not $childReply.ok){throw 'CHILD_CREATE_FAILED'}
    $task=$childReply.result
    $dispatchId="attempt-$run"
    $dispatch=Call-Core 'capability.execute' @{requestId=$dispatchId;capability='agent.run';taskId=$task.id;workspaceId=$workspaceId;input=@{agentProvider='cetamesh';modelProvider='openai';model='environment-fixture';content='Analyze fixture.txt without modifying anything.'}}
    if(-not $dispatch.ok -or $dispatch.result.status -ne 'completed' -or $dispatch.result.result.accepted -ne $true){throw 'AGENT_DISPATCH_NOT_ACCEPTED'}
    $read=Call-Core 'task.get' @{id=$task.id}
    if(-not $read.ok){throw 'CHILD_READ_FAILED'}
    $task=$read.result.task
    $attempt=@($task.attempts | Where-Object {$_.requestId -eq $dispatchId})
    if($attempt.Count -ne 1 -or $attempt[0].state -ne 'accepted'){throw 'REAL_ATTEMPT_NOT_ACCEPTED'}
    $inferenceDeadline=[Math]::Min($deadline,(Now)+15000)
    while(-not (Test-Path -LiteralPath $inference) -and (Now) -lt $inferenceDeadline){Start-Sleep -Milliseconds 100}
    if(-not (Test-Path -LiteralPath $inference)){throw 'REAL_INFERENCE_NOT_OBSERVED'}
    if($r.packIds -contains 'W04'){Check W04 task-attempt PASS OBSERVED @{actual=$true;taskId=$task.id;attemptId=$attempt[0].id;attemptExecuted=$true;attemptState='accepted';requestId=$dispatchId;provider='cetamesh';inferenceObserved=$true}}
    $oldPid=$core.Id; $birth=$core.StartTime.ToUniversalTime().ToString('o')
    $core.Kill()
    if(-not $core.WaitForExit(5000)){throw 'CORE_EXIT_UNKNOWN'}
    if($r.packIds -contains 'W06'){Check W06 cancel-owned PASS OBSERVED @{actual=$true;pid=$oldPid;startedAt=$birth;exitConfirmed=$true;scope='owned Core process with accepted child Attempt'}}
    $core=Start-OwnedCore
    $persisted=Call-Core 'task.get' @{id=$task.id}
    if(-not $persisted.ok){throw 'TASK_PERSISTENCE_FAILED'}
    $recovered=$persisted.result.task
    $unknown=@($recovered.attempts | Where-Object {$_.id -eq $attempt[0].id})
    if($recovered.status -ne 'blocked' -or $unknown.Count -ne 1 -or $unknown[0].state -ne 'unknown' -or $recovered.progress.note -notmatch 'needs-reconciliation'){throw 'ATTEMPT_UNKNOWN_RECOVERY_FAILED'}
    # This is a deliberate negative authorization probe, never a blind retry.
    $refused=Call-Core 'capability.execute' @{requestId="blocked-$run";capability='agent.run';taskId=$task.id;workspaceId=$workspaceId;input=@{agentProvider='cetamesh';modelProvider='openai';model='environment-fixture';content='Must be rejected until Owner reconciliation.'}}
    if($refused.ok -or $refused.error.code -ne 'NEEDS_RECONCILIATION'){throw 'UNKNOWN_ATTEMPT_REDISPATCH_ALLOWED'}
    $after=Call-Core 'task.get' @{id=$task.id}
    if(-not $after.ok -or @($after.result.task.attempts).Count -ne @($recovered.attempts).Count){throw 'UNKNOWN_ATTEMPT_REPLAYED'}
    if($r.packIds -contains 'W06') {
      Check W06 crash-restart PASS OBSERVED @{actual=$true;oldPid=$oldPid;newPid=$core.Id;taskId=$task.id;persistenceRead=$true}
      Check W06 unknown-outcome PASS OBSERVED @{actual=$true;attemptId=$attempt[0].id;attemptState='unknown';taskStatus='blocked';replayed=$false;reconciliationRequired=$true;rejectionCode=$refused.error.code}
    }
  } finally {
    if($null -ne $core -and -not $core.HasExited){$core.Kill();if(-not $core.WaitForExit(5000)){throw 'CORE_CLEANUP_UNKNOWN'}}
    if($null -ne $providerServer){Stop-Job $providerServer;Remove-Job $providerServer -Force}
    $token=$null
  }
}
