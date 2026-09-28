!ifndef BUILD_UNINSTALLER
  ; NSIS uses the final component of InstallDir when returning from Browse.
  ; Setting $INSTDIR at runtime alone does not enable that native behavior.
  ; electron-builder still restores existing installations and /D overrides.
  InstallDir "$LOCALAPPDATA\Programs\Feishu Codex"
  !define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置，安装程序会自动创建 Feishu Codex 文件夹。"
!endif

!macro feishuSafeStop PHASE
  InitPluginsDir
  ; Embed the helper so upgrading an older build also uses the new exit checks.
  File /oname=$PLUGINSDIR\desktop-uninstall.ps1 "${PROJECT_DIR}\scripts\desktop-uninstall.ps1"
  File /oname=$PLUGINSDIR\desktop-process-tree.ps1 "${PROJECT_DIR}\scripts\desktop-process-tree.ps1"
  File /oname=$PLUGINSDIR\desktop-clear-data.ps1 "${PROJECT_DIR}\scripts\desktop-clear-data.ps1"
  Push $R0
  Push $R1
  Push $R2
  ; NSIS is 32-bit. Sysnative selects 64-bit PowerShell so executable identity
  ; checks can inspect the 64-bit Electron and Codex processes correctly.
  StrCpy $R2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToStack '"$R2" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\desktop-uninstall.ps1" -InstallDir "$INSTDIR" -Phase ${PHASE}'
  Pop $R0
  Pop $R1
  DetailPrint "$R1"
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法安全退出，安装或卸载已取消。请打开 Feishu Codex，等待任务结束并退出全部服务后重试。详情见用户目录 .feishu-codex\desktop\uninstall.log。" /SD IDOK
    Pop $R2
    Pop $R1
    Pop $R0
    SetErrorLevel 1
    Quit
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customCheckAppRunning
  !insertmacro feishuSafeStop Prepare
!macroend

!ifdef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  Var feishuClearData
  Var feishuClearDataCheckbox

  !macro customUnWelcomePage
    !insertmacro MUI_UNPAGE_WELCOME
    UninstPage custom un.FeishuDataPage un.FeishuDataLeave
  !macroend

  !macro customHeader
  Function un.FeishuDataPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "卸载选项" "选择是否保留本机配置"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 28u "默认保留配置，重新安装后可以继续使用。"
    Pop $0
    ${NSD_CreateCheckbox} 0 35u 100% 14u "清除本应用数据"
    Pop $feishuClearDataCheckbox
    ${NSD_SetState} $feishuClearDataCheckbox ${BST_UNCHECKED}
    ${NSD_CreateLabel} 12u 58u 94% 42u "清除飞书凭据、授权名单、会话绑定、偏好、日志和缓存。此操作不可撤销。"
    Pop $0
    ${NSD_CreateLabel} 12u 110u 94% 35u "Codex 登录信息、Codex 会话历史和项目文件始终保留。"
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function un.FeishuDataLeave
    ${NSD_GetState} $feishuClearDataCheckbox $feishuClearData
  FunctionEnd
  !macroend
!endif

!macro customUnInstall
  ; The same uninstaller is used during upgrades. Keep the Skill until a real uninstall.
  ${ifNot} ${isUpdated}
    !insertmacro feishuSafeStop Cleanup
    IfFileExists "$INSTDIR\resources\node\node.exe" 0 feishu_skill_done
    IfFileExists "$INSTDIR\resources\product\scripts\remove-bundled-skill.mjs" 0 feishu_skill_done
    Push $R0
    Push $R1
    nsExec::ExecToStack '"$INSTDIR\resources\node\node.exe" "$INSTDIR\resources\product\scripts\remove-bundled-skill.mjs"'
    Pop $R0
    Pop $R1
    DetailPrint "Feishu Codex Skill cleanup: $R0 $R1"
    ${If} $R0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "内置 Skill 暂时无法清理，卸载已取消。请关闭占用该文件的程序后重试。" /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
    Pop $R1
    Pop $R0
    feishu_skill_done:
    ${If} $feishuClearData == 1
      !insertmacro feishuSafeStop ClearData
    ${EndIf}
  ${endif}
!macroend
