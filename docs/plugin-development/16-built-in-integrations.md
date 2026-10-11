# 16 Built-in Integrations

Some CetaMesh product entries represent an installed application or a built-in domain integration rather than a third-party extension package.

Examples include:

- **DeepSeek Harness**: its Desktop App is detected and opened by the DSH Integration service; its Agent execution remains in the existing DSH Agent Provider and Agent Broker.
- **SnowLuma**: its product entry connects to the existing Channel Provider and local service.

These entries use built-in Integration Descriptors. They do not use `.cetamesh-plugin` package installation, Extension Runtime, or `ProcessExtensionHost`. Do not wrap an existing Agent or Channel Provider in a second extension process just to display it in the Plugin Center.

Third-party plugins still declare capabilities in their manifest and run through Extension Runtime, review, and the hosting mode documented in [05 Process Host](05-process-host.md). A built-in integration must keep its product availability separate from the underlying Provider's runtime health.

For the DSH-specific boundary, see [DeepSeek Harness Integration](../integrations/DSH.md).
