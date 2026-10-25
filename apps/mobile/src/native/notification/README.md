# notification.send provider

`NotificationSendProvider` is registered in the M4 Capability Runtime. It
accepts only a bounded title and optional body after the shared Policy grants
one use. Android and iOS request their own notification permission and create a
local notification. The provider does not accept URLs, arbitrary intent data,
userInfo, scripts or executable content.

Android uses a non-exported permission Activity and a dedicated notification
channel. iOS uses `UNUserNotificationCenter`. An OS denial is returned as
`permission_denied`; missing native integration is `unsupported`.
