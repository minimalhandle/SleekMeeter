; Extra steps for Sleekmeeter's per-user installer (Tauri NSIS hooks).
; Sleekmeeter needs Voicemeeter, which is made by VB-Audio and is never downloaded or run by us.
; If it's missing, the installer says so and offers to open VB-Audio's download page.

!macro NSIS_HOOK_PREINSTALL
  IfSilent sleekmeeter_vm_done
  StrCpy $R8 ""
  SetRegView 64
  ReadRegStr $R8 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}" "UninstallString"
  StrCmp $R8 "" 0 sleekmeeter_vm_done
  SetRegView 32
  ReadRegStr $R8 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}" "UninstallString"
  SetRegView 64
  StrCmp $R8 "" 0 sleekmeeter_vm_done
  MessageBox MB_YESNOCANCEL|MB_ICONINFORMATION "Sleekmeeter needs Voicemeeter (Banana or Potato), a free mixer made by VB-Audio, and it isn't installed on this PC.$\r$\n$\r$\nYes: open VB-Audio's download page, then keep installing Sleekmeeter$\r$\nNo: keep installing Sleekmeeter without it$\r$\nCancel: stop$\r$\n$\r$\nAfter installing Voicemeeter, restart your PC once so its audio drivers start working." IDYES sleekmeeter_vm_open IDNO sleekmeeter_vm_done
  Quit
  sleekmeeter_vm_open:
  ExecShell "open" "https://vb-audio.com/Voicemeeter/banana.htm"
  sleekmeeter_vm_done:
  SetRegView 64
!macroend
