# CetaMesh application icons

`source-logo-05.png` is the active master. It was generated from the user-provided
`CetaMesh-Logo-05.png` reference with the built-in ImageGen tool on 2026-10-05.
Only the rounded blue tile and white/cyan whale were retained; the presentation
border, wordmark and caption are excluded.

Generation direction: preserve the flowing whale silhouette, cyan-to-cobalt blue
tile, blue eye and clear small-size shape; transparent outside corners, no text,
no external shadow. The generator applies a consistent rounded clipping contour.

Master SHA-256: `40c074d92d640ae785357393f3855e98a589d44d91f59d3a247aa7e8de4ccf8f`.

Run `npm run build:icons` from the repository root. Outputs:

- PNG: 32, 128, 256 and 512 px in this directory.
- ICO: 16, 20, 24, 32, 40, 48, 64, 128 and 256 px frames.
- `public/whalebridge-icon.png`: the same 256 px brand asset.

The Rust window and installer window use the 128 px PNG. The Windows executable
resource and installer packaging use the ICO; the tray loads that resource with
the 32 px PNG as fallback. Rebuild the executable/package to pick up changed assets.

`source-c4.png` is preserved unchanged for provenance. Its SHA-256 remains
`50f4f510502ea0dfee14abdbc4c318cd3d14a352ef24e8ff1e2ad111a89ed98b`.
`node scripts/test-app-icon.mjs` checks that legacy source and regenerates the active
outputs in a temporary directory to check reproducibility on Windows.
