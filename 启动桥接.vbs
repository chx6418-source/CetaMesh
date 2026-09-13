' QQ Bridge silent launcher: runs the guard loop fully hidden (no console window,
' no taskbar entry). The bridge opens the default browser itself once the port
' is listening (first launch only).
Set sh = CreateObject("WScript.Shell")
dir = Replace(WScript.ScriptFullName, "\" & WScript.ScriptName, "")
sh.CurrentDirectory = dir
sh.Run "cmd /c call """ & dir & "\start.bat"" --open", 0, False
