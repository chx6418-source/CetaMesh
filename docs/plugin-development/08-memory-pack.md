# 08 Memory Pack

A Memory Pack does not receive blanket access to user Memory. Declare memory.read or memory.write only when required and route operations through the CetaMesh Memory and Capability services.

Keep imported data attributable and reviewable. Do not silently replace or delete user data during install, update, rollback, or uninstall. Handle denied or unavailable Memory access safely.
