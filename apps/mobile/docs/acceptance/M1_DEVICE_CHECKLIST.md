# M1 — Standalone Alpha device acceptance

Status: native and real-API verification pending; not a Gate PASS.
All checks below require a native build and the user's own trusted model provider.

1. Fresh install on Android without Desktop, DSH or QQ. Confirm DB/runtime initialization and provider setup.
2. Save a provider key; inspect SQLite to confirm only credential_ref exists. Restart and verify the key still works.
3. Discover models or enter a Model ID manually; create two sessions with different model/reasoning/mode settings.
4. Send multiple turns, observe actual incremental output, Stop mid-stream, and Retry. Confirm one original user message.
5. Lose connectivity/time out during a reply; inspect typed safe errors and retry behavior.
6. Force-stop during a reply, relaunch, and confirm history/partial text/settings are retained; interrupted reply is failed.
7. Rename, archive/unarchive, page history and sessions, and delete a session through confirmation.
8. Approve attachment once, select a small JPEG/PNG/WebP or plain-text/CSV/JSON file.
   Confirm no upload before Send, remove a staged file, then send and restart to confirm attachment history.
9. Cancel or deny picker access. Try oversized/unsupported content. Verify no broad storage grant, camera/mic access or arbitrary path input.
10. Update key/address; simulate secure-store/DB error if feasible. Verify previous published configuration remains correctly paired.
11. Delete the provider key, restart and send: receive unauthorized rather than insecure fallback.
12. Check final Android merged Manifest permissions; verify Keystore, SQLite and all picked URI formats on real devices.
13. On macOS install Pods, build iOS and exercise the same secure-storage/chat/picker flows.
14. Native TLS test: invalid certificate and HTTPS redirect behavior; ensure no secret transmission to an untrusted target.

Attach command output/device details to PROJECT_STATE.md. Mark only executed checks PASS.
NOT_RUN_ENVIRONMENT remains the correct result for unavailable tools, device or API credentials.
M2 is not part of this acceptance run.
