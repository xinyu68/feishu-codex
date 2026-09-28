[CmdletBinding()]
param([string]$SourceImage = (Join-Path (Split-Path $PSScriptRoot -Parent) 'desktop\assets\feishu-codex-icon-v2.png'))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'desktop\assets'
New-Item -ItemType Directory -Path $assetRoot -Force | Out-Null
$images = @()
$source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $SourceImage).Path)
try {
  if ($source.Width -ne $source.Height) { throw 'The application icon source must be square.' }
  foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $attributes = New-Object System.Drawing.Imaging.ImageAttributes
    $stream = New-Object System.IO.MemoryStream
    try {
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
      $rectangle = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
      $graphics.DrawImage($source, $rectangle, 0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $images += ,@{ Size = $size; Bytes = $stream.ToArray() }
      if ($size -eq 256) { $bitmap.Save((Join-Path $assetRoot 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
    } finally { $stream.Dispose(); $attributes.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
  }
} finally { $source.Dispose() }
$output = [System.IO.File]::Create((Join-Path $assetRoot 'icon.ico'))
$writer = New-Object System.IO.BinaryWriter($output)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
  $offset = 6 + 16 * $images.Count
  foreach ($item in $images) {
    $dimension = if ($item.Size -eq 256) { 0 } else { $item.Size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$item.Bytes.Length); $writer.Write([uint32]$offset)
    $offset += $item.Bytes.Length
  }
  foreach ($item in $images) { $writer.Write([byte[]]$item.Bytes) }
} finally { $writer.Dispose(); $output.Dispose() }
