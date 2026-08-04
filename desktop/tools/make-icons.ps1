# Generates the FWW B2B Admin app icons: a green rounded square with "B2B" text.
# Produces assets/icon-<size>.png for several sizes + assets/icon.png (1024).
Add-Type -AssemblyName System.Drawing

$root   = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
if (-not (Test-Path $assets)) { New-Item -ItemType Directory -Path $assets | Out-Null }

$green = [System.Drawing.ColorTranslator]::FromHtml('#9BBC0E')  # FWW brand green
$ink   = [System.Drawing.ColorTranslator]::FromHtml('#1A1A1A')  # near-black text

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded-rect background
  $r = [int]($size * 0.20)
  if ($r -lt 2) { $r = 2 }
  $d = $r * 2
  $pad = [Math]::Max(0, [int]($size * 0.02))
  $w = $size - 1 - ($pad * 2)
  $h = $size - 1 - ($pad * 2)
  $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path2.AddArc($pad, $pad, $d, $d, 180, 90)
  $path2.AddArc($pad + $w - $d, $pad, $d, $d, 270, 90)
  $path2.AddArc($pad + $w - $d, $pad + $h - $d, $d, $d, 0, 90)
  $path2.AddArc($pad, $pad + $h - $d, $d, $d, 90, 90)
  $path2.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush($green)
  $g.FillPath($brush, $path2)

  # "B2B" text, bold, centered
  $fontSize = [single]($size * 0.34)
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment     = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $tb = New-Object System.Drawing.SolidBrush($ink)
  $rect = New-Object System.Drawing.RectangleF(0, [single]($size * -0.02), [single]$size, [single]$size)
  $g.DrawString('B2B', $font, $tb, $rect, $fmt)

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "wrote $path"
}

foreach ($s in 16,24,32,48,64,128,256,512) {
  New-Icon $s (Join-Path $assets ("icon-$s.png"))
}
New-Icon 1024 (Join-Path $assets 'icon.png')
Write-Host 'DONE'
