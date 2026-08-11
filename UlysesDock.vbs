' UlysesDock launcher - starts the app without a console window (dev machines running from source)
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir
shell.Run """" & appDir & "\node_modules\electron\dist\electron.exe"" .", 0, False
