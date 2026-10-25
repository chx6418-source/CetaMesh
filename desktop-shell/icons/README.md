# CetaMesh application icons

The active artwork is the Owner-provided green CetaMesh mark (2026-10-22).
The four `cetamesh-icon-{180,256,512,1024}.png` files are preserved byte-for-byte
from the supplied images. Builds use repository-relative paths and do not depend
on an external image-source directory.

The default master is `cetamesh-icon-1024.png`. Exact-size 256 and 512 images are
copied unchanged; missing sizes are resampled. No padding, extra rounded clipping,
background or shadow is added. Original transparency and proportions are retained.

Run `npm run build:icons` from the repository root. Outputs:

- PNG: 32, 128, 256 and 512 px in this directory.
- ICO: 16, 20, 24, 32, 40, 48, 64, 128 and 256 px frames.
- `public/whalebridge-icon.png`: the same 256 px brand asset.

The Rust window and installer window use the 128 px PNG. The Windows executable
resource and installer packaging use the ICO; the tray loads that resource with
the 32 px PNG as fallback. Shortcuts use the executable icon. Rebuild and upgrade
the installed executable/package to see changed assets; source changes do not
alter an application that is already running.

`source-c4.png` is preserved unchanged for provenance. Its SHA-256 remains
`50f4f510502ea0dfee14abdbc4c318cd3d14a352ef24e8ff1e2ad111a89ed98b`.
`source-logo-05.png` is also retained unchanged as historical provenance.
Neither historical source is an active default.

`npm test -- --suite test-app-icon --suite test-installer-package` checks original
hashes, exact-size preservation, reproducible outputs and the installer icon
extracted by Windows. Set `CETAMESH_ICON_EXECUTABLE` to a rebuilt Host to verify
every ICO frame and the window PNG are embedded in the actual executable.
