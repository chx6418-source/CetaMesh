param(
  [string]$Source,
  [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Source)) {
  $Source = Join-Path $repoRoot 'desktop-shell\icons\cetamesh-icon-1024.png'
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $repoRoot 'desktop-shell\icons'
}
$Source = [IO.Path]::GetFullPath($Source)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Icon source not found: $Source"
}

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

function Save-IconPng([System.Drawing.Image]$sourceImage, [int]$size, [string]$destination) {
  # Prefer the Owner's exact-size files; do not add padding or clip the artwork.
  if ([IO.Path]::GetFileName($Source) -eq 'cetamesh-icon-1024.png') {
    $provided = Join-Path ([IO.Path]::GetDirectoryName($Source)) "cetamesh-icon-$size.png"
    if (Test-Path -LiteralPath $provided -PathType Leaf) {
      Copy-Item -LiteralPath $provided -Destination $destination -Force
      return
    }
  }
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
    $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Write-Ico([string]$destination, [object[]]$frames) {
  $stream = New-Object IO.MemoryStream
  $writer = New-Object IO.BinaryWriter($stream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
      $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$frame.Bytes.Length)
      $writer.Write([uint32]$offset)
      $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) {
      $writer.Write([byte[]]$frame.Bytes)
    }
    $writer.Flush()
    [IO.File]::WriteAllBytes($destination, $stream.ToArray())
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

$sourceImage = [System.Drawing.Image]::FromFile($Source)
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("whalebridge-icons-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  $namedOutputs = @{
    32  = '32x32.png'
    128 = '128x128.png'
    256 = '128x128@2x.png'
    512 = 'icon.png'
  }
  foreach ($entry in $namedOutputs.GetEnumerator()) {
    Save-IconPng $sourceImage ([int]$entry.Key) (Join-Path $OutputDir $entry.Value)
  }

  $frames = @()
  foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 128, 256)) {
    $framePath = Join-Path $tempDir ("$size.png")
    Save-IconPng $sourceImage $size $framePath
    $frames += [PSCustomObject]@{ Size = $size; Bytes = [IO.File]::ReadAllBytes($framePath) }
  }
  Write-Ico (Join-Path $OutputDir 'icon.ico') $frames

  $publicIcon = Join-Path $repoRoot 'public\whalebridge-icon.png'
  Save-IconPng $sourceImage 256 $publicIcon
} finally {
  $sourceImage.Dispose()
  if (Test-Path -LiteralPath $tempDir) {
    $resolvedTemp = [IO.Path]::GetFullPath($tempDir)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (([IO.Path]::GetDirectoryName($resolvedTemp) -ne $tempRoot) -or
        -not ([IO.Path]::GetFileName($resolvedTemp).StartsWith('whalebridge-icons-'))) {
      throw "Refusing to clean unexpected temporary path: $resolvedTemp"
    }
    Remove-Item -LiteralPath $tempDir -Recurse -Force
  }
}

Write-Host "WhaleBridge icons generated: $OutputDir"
Write-Host '  icon.ico: 16/20/24/32/40/48/64/128/256 px'
Write-Host '  PNG: 32x32, 128x128, 256x256, 512x512'
Write-Host '  UI: 256x256 brand image for the public console pages'
