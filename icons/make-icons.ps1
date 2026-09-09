$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = $PSScriptRoot
$sizes  = @(16, 48, 128)
$bgColor    = [System.Drawing.Color]::FromArgb(255, 29, 155, 240)   # X blue
$fgColor    = [System.Drawing.Color]::White

function Draw-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode   = 'HighQuality'

    # Background: rounded square
    $bgBrush = New-Object System.Drawing.SolidBrush $bgColor
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $radius = [int]($size * 0.22)
    $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path2.AddArc(0, 0, $radius, $radius, 180, 90)
    $path2.AddArc($size - $radius, 0, $radius, $radius, 270, 90)
    $path2.AddArc($size - $radius, $size - $radius, $radius, $radius, 0, 90)
    $path2.AddArc(0, $size - $radius, $radius, $radius, 90, 90)
    $path2.CloseFigure()
    $g.FillPath($bgBrush, $path2)

    # Foreground: white X plus a yellow broom, legible at 16px
    $fgBrush = New-Object System.Drawing.SolidBrush $fgColor
    $penWidth1 = [single]($size * 0.10)
    $fgPen     = New-Object System.Drawing.Pen($fgColor, $penWidth1)
    $fgPen.StartCap = 'Round'
    $fgPen.EndCap   = 'Round'

    # X mark
    $xPen = New-Object System.Drawing.Pen($fgColor, [single]($size * 0.13))
    $xPen.StartCap = 'Round'; $xPen.EndCap = 'Round'
    $xPad = [single]($size * 0.24)
    $g.DrawLine($xPen, $xPad, $xPad, [single]($size * 0.60), [single]($size * 0.60))
    $g.DrawLine($xPen, [single]($size * 0.60), $xPad, $xPad, [single]($size * 0.60))

    # Diagonal handle
    $pad = [int]($size * 0.22)
    $g.DrawLine($fgPen, [single]$pad, [single]($size - $pad), [single]($size - $pad), [single]$pad)

    # Yellow broom head at top-right
    $fgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 214, 10))
    $bh = [int]($size * 0.30)
    $bw = [int]($size * 0.20)
    $bx = $size - $pad - [int]($bw * 0.6)
    $by = $pad - [int]($bh * 0.3)
    $brushRect = New-Object System.Drawing.Rectangle $bx, $by, $bw, $bh
    $g.FillRectangle($fgBrush, $brushRect)

    # Bristle lines under brush head
    $penWidth2 = [single]($size * 0.06)
    $pen2      = New-Object System.Drawing.Pen($fgColor, $penWidth2)
    $pen2.StartCap = 'Round'
    $g.DrawLine($pen2, $bx, $by + $bh, $bx + [int]($bw * 0.25), $by + $bh + [int]($bh * 0.35))
    $g.DrawLine($pen2, $bx + [int]($bw * 0.5), $by + $bh, $bx + [int]($bw * 0.5), $by + $bh + [int]($bh * 0.5))
    $g.DrawLine($pen2, $bx + [int]($bw * 0.75), $by + $bh, $bx + $bw, $by + $bh + [int]($bh * 0.35))

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  generated $path ($size x $size)"
}

foreach ($s in $sizes) {
    Draw-Icon -size $s -path (Join-Path $outDir "icon${s}.png")
}

Write-Host "All icons generated."
