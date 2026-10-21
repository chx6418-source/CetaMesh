# 03 Capabilities

Each capability declares a unique id, kind, title, description, required permissions, and optional JSON inputSchema. Its required permissions must also appear in the manifest. The Extension Runtime registers it under the extension-qualified id and routes invocation through the Capability Broker.

Constrain inputs and validate them again in handler code. Disabled or crashed extensions do not expose callable capabilities.
