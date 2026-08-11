' UlysesDock launcher - starts the app without a console window (dev machines running from source)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\YAC.BENAKMOUME\IdeaProjects\workdock"
shell.Run """C:\Users\YAC.BENAKMOUME\IdeaProjects\workdock\node_modules\electron\dist\electron.exe"" .", 0, False
