' QQ Bridge silent restarter: stops the old hidden guard + bridge processes and
' relaunches them in the background. No console window will appear. The bridge
' re-opens the default browser automatically once the port is listening again.
Set sh = CreateObject("WScript.Shell")
dir = Replace(WScript.ScriptFullName, "\" & WScript.ScriptName, "")
sh.CurrentDirectory = dir
sh.Run "cmd /c call """ & dir & "\restart.bat""", 0, True
