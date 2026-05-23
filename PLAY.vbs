Set fso = CreateObject("Scripting.FileSystemObject")
gameDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set WS = CreateObject("WScript.Shell")
WS.Run "cmd /c cd /d """ & gameDir & """ && npm install --silent && node server.js", 0, False
