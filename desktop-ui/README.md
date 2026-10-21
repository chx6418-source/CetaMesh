# CetaMesh Desktop UI v2 — 01 Harbor

This is the canonical local renderer for CetaMesh Desktop. The production entry is
`src/main.tsx` → `src/app/HarborApp.tsx`; it follows the Owner-selected 01 Harbor screenshots and
reads product state through typed DTOs from the existing Rust/WebView2 host and Core services.

## Install and build

```powershell
npm ci --offline --prefix desktop-ui
npm run build:ui
```

The production build writes static assets to `desktop-ui/dist`. The Rust host serves these files from
`resources/desktop-ui/` over its local custom protocol; it does not use a production HTTP listener.
For UI development only, `npm --prefix desktop-ui run dev` binds `127.0.0.1:5173`; the Rust host
accepts that origin only in a debug build with `--dev-ui-url=http://127.0.0.1:5173`.

## Build and checks

```powershell
npm run build:ui
npm --prefix desktop-ui run lint
```

The supported repository test entry is `npm test`; the registered
`test-desktop-ui-v2-production.mjs` suite checks the selected Harbor entry, typed bridge, release
packaging contract and host security policy. The UI source contains no production mock-data import.

## Native host

Build the Rust debug shell to use the default WebView2 Harbor UI. Only debug builds accept
`--dev-ui-url=http://127.0.0.1:5173` for HMR. Release assembly builds the UI and stages the files in
`resources/desktop-ui/`; the Rust custom protocol serves them without opening a localhost HTTP
listener.
