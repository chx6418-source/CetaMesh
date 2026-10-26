param([Parameter(Mandatory=$true)][string]$RequestFile)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$r=Get-Content -LiteralPath $RequestFile -Raw|ConvertFrom-Json
$run=[guid]::Parse($r.binding.runId).ToString();$root="C:\CetaMeshEnv\$run"
if($r.guestRoot -cne $root -or $RequestFile -cne "$root\request.json"){throw 'GUEST_UI_PATH'}
$guard=Get-Content -LiteralPath "$root\guard.json" -Raw|ConvertFrom-Json
$system=Get-CimInstance Win32_ComputerSystem
if($guard.version -ne 1 -or $r.version -ne 1 -or $r.binding.capability -ne 'environment.test' -or $guard.runId -ne $run -or $guard.environmentId -ne $r.binding.environmentId -or $guard.guestVmId -ne (Get-CimInstance Win32_ComputerSystemProduct).UUID -or $system.Model -ne 'Virtual Machine' -or $system.Manufacturer -ne 'Microsoft Corporation' -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){throw 'GUEST_UI_GUARD'}
foreach($path in @($root,"$root\request.json","$root\installed","$root\installed\WhaleBridge.exe","$root\evidence","$root\runner","$root\runner\guest-core.ps1")){if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'GUEST_UI_REPARSE'}}
$started=Now;$deadline=[Math]::Min([double]$r.binding.expiresAt,$started+[double]$r.binding.limits.timeoutMs)
if($deadline -le $started){throw 'GUEST_UI_EXPIRED'}
$checks=New-Object 'Collections.Generic.List[object]'
function Add-Check($pack,$id,$status,$code,$observations){$checks.Add(@{packId=$pack;id=$id;status=$status;code=$code;layer='Windows VM E2E';observations=$observations;startedAt=$started;endedAt=(Now)})}
function Save-OwnedWindow([string]$fileName) {
  $gui.Refresh()
  if($gui.HasExited -or $gui.MainWindowHandle -eq [IntPtr]::Zero -or $gui.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'SCREENSHOT_WINDOW_NOT_OWNED'}
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  if(-not ('EnvironmentWindowCapture' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EnvironmentWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
  }
  $rect=New-Object EnvironmentWindowCapture+RECT
  $ownerPid=[uint32]0
  $null=[EnvironmentWindowCapture]::GetWindowThreadProcessId($gui.MainWindowHandle,[ref]$ownerPid)
  if($ownerPid -ne $gui.Id -or [EnvironmentWindowCapture]::GetForegroundWindow() -ne $gui.MainWindowHandle -or -not [EnvironmentWindowCapture]::GetWindowRect($gui.MainWindowHandle,[ref]$rect)){throw 'SCREENSHOT_WINDOW_NOT_FOREGROUND'}
  $width=$rect.Right-$rect.Left;$height=$rect.Bottom-$rect.Top
  if($width -le 0 -or $height -le 0 -or $width -gt 3840 -or $height -gt 2160 -or ([long]$width*$height) -gt 4194304){throw 'SCREENSHOT_PIXEL_LIMIT'}
  $bounds=New-Object Drawing.Rectangle($rect.Left,$rect.Top,$width,$height)
  if(-not [Windows.Forms.SystemInformation]::VirtualScreen.Contains($bounds)){throw 'SCREENSHOT_WINDOW_OFFSCREEN'}
  $bitmap=New-Object Drawing.Bitmap($width,$height)
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  try {$graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size);$bitmap.Save("$root\evidence\$fileName",[Drawing.Imaging.ImageFormat]::Png)} finally {$graphics.Dispose();$bitmap.Dispose()}
  return $fileName
}
. "$root\runner\guest-core.ps1"
$gui=$null;$server=$null;$uiPhase='launch';$uiaObserved=$false
try {
  try { Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes } catch { throw 'UIA_DEPENDENCY_MISSING' }
  try { $gui=Start-Process -FilePath "$root\installed\WhaleBridge.exe" -ArgumentList @('--data-dir',"$root\ui-data") -PassThru } catch { throw 'GUI_LAUNCH_FAILED' }
  while((Now) -lt $deadline){$gui.Refresh();if($gui.HasExited){throw 'GUI_EXITED'};if($gui.MainWindowHandle -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 250}
  if($gui.MainWindowHandle -eq [IntPtr]::Zero){throw 'GUI_WINDOW_UNAVAILABLE'}
  $firstScreenshot=Save-OwnedWindow 'window-first.png'
  if($r.packIds -contains 'W02'){
    Add-Check W02 gui-process PASS OBSERVED @{actual=$true;pid=$gui.Id;startedAt=$gui.StartTime.ToUniversalTime().ToString('o');sessionId=$gui.SessionId}
    Add-Check W02 gui-window PASS OBSERVED @{actual=$true;pid=$gui.Id;windowHandle=$gui.MainWindowHandle.ToInt64();screenshot=$firstScreenshot}
  }
  if($r.packIds -contains 'W03'){
    # Loopback synthetic provider lives only in this disposable Guest; no real credential.
    $server=Start-Job -ScriptBlock {
      $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,19389)
      $listener.Start()
      try { while($true){
        $client=$listener.AcceptTcpClient();$stream=$client.GetStream();$stream.ReadTimeout=5000
        try {
          $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::ASCII,$false,1024,$true)
          $request=$reader.ReadLine();do{$line=$reader.ReadLine()}while($line)
          $body='{"id":"environment-fixture","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"Guest fixture ready"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}'
          if($request -match '/models'){$body='{"object":"list","data":[{"id":"environment-fixture","object":"model"}]}'}
          $bytes=[Text.Encoding]::UTF8.GetBytes($body)
          $header=[Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
          $stream.Write($header,0,$header.Length);$stream.Write($bytes,0,$bytes.Length)
        } finally {$client.Dispose()}
      }} finally {$listener.Stop()}
    }
    $window=[Windows.Automation.AutomationElement]::FromHandle($gui.MainWindowHandle)
    function Find-Name([string]$name) {
      $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$name)
      return $window.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
    }
    function Wait-Name([string]$name) {
      $end=[Math]::Min($deadline,(Now)+15000)
      while((Now) -lt $end){
        $gui.Refresh();if($gui.HasExited){throw 'GUI_EXITED'}
        $element=Find-Name $name
        if($null -ne $element){$script:uiaObserved=$true;return $element}
        Start-Sleep -Milliseconds 200
      }
      if($uiPhase -eq 'model-step4'){throw 'ONBOARDING_STEP4_STALLED'}
      if($uiaObserved){throw 'UIA_FLOW_TIMEOUT'}
      $elements=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
      if($elements.Count -gt 0){throw 'UIA_FLOW_TIMEOUT'}
      throw 'UIA_TREE_UNOBSERVABLE'
    }
    function Invoke-Name([string]$name){$element=Wait-Name $name;$pattern=$null;if(-not $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){throw 'UIA_PATTERN_UNSUPPORTED'};$pattern.Invoke()}
    function Set-Value([string]$name,[string]$value){$element=Wait-Name $name;$pattern=$null;if(-not $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){throw 'UIA_PATTERN_UNSUPPORTED'};$pattern.SetValue($value)}
    Invoke-Name '继续设置'
    Set-Value 'API Key' 'environment-synthetic-key'
    Set-Value '服务商 Base URL（可选）' 'http://127.0.0.1:19389/v1'
    Invoke-Name '保存并测试连接'
    $uiPhase='provider'
    $save=Wait-Name '保存默认模型'
    $uiPhase='model-step4'
    $model=Find-Name '默认模型 ID'
    if($null -ne $model){Set-Value '默认模型 ID' 'environment-fixture'} else {
      $combo=Wait-Name '默认模型'
      $expand=$null
      if($combo.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$expand)){$expand.Expand()}
      else {
        # Harbor Select is a button with aria-expanded and a portal listbox.
        $invoke=$null
        if(-not $combo.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)){throw 'UIA_PATTERN_UNSUPPORTED'}
        $invoke.Invoke()
      }
      $option=Wait-Name 'environment-fixture'
      $selection=$null
      if($option.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection)){$selection.Select()}
      else {
        $invoke=$null
        if(-not $option.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)){throw 'UIA_PATTERN_UNSUPPORTED'}
        $invoke.Invoke()
      }
    }
    Invoke-Name '保存默认模型'
    $null=Wait-Name '稍后设置'
    $uiPhase='optional-and-chat'
    Add-Check W03 model-step4 PASS OBSERVED @{actual=$true;driver='UIAutomation';step=4;savedModel='environment-fixture';advanced=$true;provider='synthetic-loopback'}
    Invoke-Name '稍后设置';Start-Sleep -Milliseconds 400;Invoke-Name '稍后设置'
    Invoke-Name '完成并进入 Chat'
    $null=Wait-Name '新建会话'
    if($null -ne (Find-Name '保存默认模型')){throw 'ONBOARDING_STILL_VISIBLE'}
    $chatScreenshot=Save-OwnedWindow 'window-chat.png'
    Add-Check W03 chat-reached PASS OBSERVED @{actual=$true;driver='UIAutomation';chatVisible=$true;observedControl='新建会话';screenshot=$chatScreenshot}
  }
} catch {
  $code='GUEST_OPERATION_UNCLASSIFIED'
  if($_.Exception.Message -match '^[A-Z][A-Z0-9_]+$'){$code=$_.Exception.Message}
  if($null -ne $gui){$gui.Refresh();if($gui.HasExited){$code='GUI_EXITED'}}
  $classification=Get-GuestFailureStatus $code
  foreach($pack in @('W02','W03')){if($r.packIds -notcontains $pack){continue};$ids=@('gui-process','gui-window');if($pack -eq 'W03'){$ids=@('model-step4','chat-reached')};foreach($id in $ids){if(-not @($checks|Where-Object {$_.packId -eq $pack -and $_.id -eq $id}).Count){Add-Check $pack $id $classification $code @{actual=$false;phase=$uiPhase;uiaObserved=$uiaObserved}}}}
} finally {
  if($null -ne $server){Stop-Job $server;Remove-Job $server -Force}
  if($null -ne $gui -and -not $gui.HasExited){$null=$gui.CloseMainWindow();if(-not $gui.WaitForExit(5000)){$gui.Kill();$null=$gui.WaitForExit(5000)}}
}
$uiLog=@($checks.ToArray() | ForEach-Object {@{packId=$_.packId;checkId=$_.id;status=$_.status;code=$_.code;at=$_.endedAt}|ConvertTo-Json -Compress}) -join [Environment]::NewLine
[IO.File]::WriteAllText("$root\evidence\ui-steps.jsonl",$uiLog,(New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText("$root\evidence\ui-result.json",(@{checks=@($checks.ToArray())}|ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
