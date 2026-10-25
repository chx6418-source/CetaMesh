param([Parameter(Mandatory = $true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
public static class IconPixels {
  public static void Equal(byte[] actual, byte[] expected, string label) {
    using (var aStream = new MemoryStream(actual))
    using (var eStream = new MemoryStream(expected))
    using (var a = new Bitmap(aStream))
    using (var e = new Bitmap(eStream)) {
      if (a.Width != e.Width || a.Height != e.Height)
        throw new Exception(label + ": decoded dimensions differ");
      long differences = 0;
      int firstX = -1, firstY = -1;
      for (int y = 0; y < a.Height; y++) for (int x = 0; x < a.Width; x++) {
        if (a.GetPixel(x, y).ToArgb() != e.GetPixel(x, y).ToArgb()) {
          if (differences == 0) { firstX = x; firstY = y; }
          differences++;
        }
      }
      if (differences != 0)
        throw new Exception(label + ": " + differences + " RGBA pixels differ; first at " + firstX + "," + firstY);
    }
  }
  static byte[] Encode(Bitmap image, ImageFormat format) {
    using (var stream = new MemoryStream()) { image.Save(stream, format); return stream.ToArray(); }
  }
  public static void SelfTest() {
    using (var a = new Bitmap(2, 2, PixelFormat.Format32bppArgb))
    using (var b = new Bitmap(2, 2, PixelFormat.Format32bppArgb)) {
      a.SetPixel(0, 0, Color.FromArgb(127, 23, 45, 67));
      b.SetPixel(0, 0, Color.FromArgb(127, 23, 45, 67));
      // Different lossless containers must compare equal; RGBA changes must not.
      Equal(Encode(a, ImageFormat.Png), Encode(b, ImageFormat.Tiff), "self-test encoding");
      foreach (var changed in new[] { Color.FromArgb(126, 23, 45, 67), Color.FromArgb(127, 24, 45, 67) }) {
        b.SetPixel(0, 0, changed);
        bool rejected = false;
        try { Equal(Encode(a, ImageFormat.Png), Encode(b, ImageFormat.Png), "self-test mutation"); }
        catch (Exception) { rejected = true; }
        if (!rejected) throw new Exception("Pixel comparator accepted a changed RGBA pixel");
      }
    }
    using (var a = new Bitmap(1, 1)) using (var b = new Bitmap(2, 1)) {
      bool rejected = false;
      try { Equal(Encode(a, ImageFormat.Png), Encode(b, ImageFormat.Png), "self-test size"); }
      catch (Exception) { rejected = true; }
      if (!rejected) throw new Exception("Pixel comparator accepted a changed size");
    }
  }
}
'@
[IconPixels]::SelfTest()
$pairs = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($pair in $pairs) {
  [IconPixels]::Equal([IO.File]::ReadAllBytes($pair.actual), [IO.File]::ReadAllBytes($pair.expected), $pair.label)
}
Write-Host 'Exact decoded RGBA equality passed for all generated PNG and ICO images.'
