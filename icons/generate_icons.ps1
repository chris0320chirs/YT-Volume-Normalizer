# PowerShell Script to generate modern icons for YT Volume Normalizer
Add-Type -AssemblyName System.Drawing

$iconsDir = $PSScriptRoot
if (-not $iconsDir) { $iconsDir = "." }

$sizes = @(16, 48, 128)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Outer rounded background
    $rect = New-Object System.Drawing.RectangleF(0.5, 0.5, ($size - 1.0), ($size - 1.0))
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 30, 30, 35),
        [System.Drawing.Color]::FromArgb(255, 12, 12, 15),
        45.0
    )

    # Draw rounded background circle
    $g.FillEllipse($bgBrush, $rect)

    # Red accent border
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 255, 30, 60), [Math]::Max(1.0, $size * 0.05))
    $g.DrawEllipse($borderPen, $rect)

    # Draw equalizer bars
    $barCount = 4
    $barHeights = @(0.45, 0.85, 0.60, 0.95)
    $barWidth = [Math]::Max(1.5, $size * 0.12)
    $gap = [Math]::Max(1.0, $size * 0.08)
    $totalWidth = ($barCount * $barWidth) + (($barCount - 1) * $gap)
    $startX = ($size - $totalWidth) / 2.0
    $centerY = $size / 2.0

    for ($i = 0; $i -lt $barCount; $i++) {
        $h = [Math]::Max(2.0, $size * 0.52 * $barHeights[$i])
        $x = $startX + ($i * ($barWidth + $gap))
        $y = $centerY - ($h / 2.0)

        $barRect = New-Object System.Drawing.RectangleF($x, $y, $barWidth, $h)
        
        $barBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $barRect,
            [System.Drawing.Color]::FromArgb(255, 255, 60, 60),
            [System.Drawing.Color]::FromArgb(255, 255, 170, 30),
            90.0
        )
        
        $g.FillRectangle($barBrush, $barRect)
        $barBrush.Dispose()
    }

    $outPath = Join-Path $iconsDir "icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $bgBrush.Dispose()
    $borderPen.Dispose()

    Write-Host "Successfully generated: $outPath ($size x $size)"
}
