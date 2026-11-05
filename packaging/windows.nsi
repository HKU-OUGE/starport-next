# -*- coding: utf-8 -*-
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
Name "Starport Next"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\StarportNext"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "0.3.0.1"
VIAddVersionKey "ProductName" "Starport Next"
VIAddVersionKey "FileDescription" "Starport Next installation launcher"
VIAddVersionKey "FileVersion" "0.3.0-beta.1"
VIAddVersionKey "LegalCopyright" "Starport Contributors"
!define MUI_WELCOMEPAGE_TITLE "Starport Next"
!define MUI_WELCOMEPAGE_TEXT "选择安装位置后，本机安装向导将打开。$\r$\n$\r$\n你可以按需选择功能、配置出口、更新或卸载已有安装。只有系统依赖步骤才会请求管理员授权。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Var Parameters
Var Verify
Var Smoke
Var Result
Function .onInit
 ${IfNot} ${RunningX64}
  MessageBox MB_ICONSTOP "This release requires Windows x64."
  Abort
 ${EndIf}
 ${GetParameters} $Parameters
 ClearErrors
 ${GetOptions} $Parameters "/VERIFY" $Verify
 ${IfNot} ${Errors}
  StrCpy $Verify "yes"
 ${EndIf}
 ClearErrors
 ${GetOptions} $Parameters "/SMOKE" $Smoke
 ${IfNot} ${Errors}
  StrCpy $Smoke "yes"
  StrCpy $Verify "yes"
 ${EndIf}
FunctionEnd
Section
 InitPluginsDir
 SetOutPath "$PLUGINSDIR\source"
 File /r "${PAYLOAD}\*"
 ${If} $Verify == "yes"
  ExecWait '"$PLUGINSDIR\source\runtime\node.exe" "$PLUGINSDIR\source\app\packages\installer\cli.mjs" --source "$PLUGINSDIR\source" --check' $Result
  ${If} $Result == 0
  ${AndIf} $Smoke == "yes"
   ExecWait '"$PLUGINSDIR\source\runtime\node.exe" "$PLUGINSDIR\source\app\scripts\test-installer-package.mjs" --source "$PLUGINSDIR\source"' $Result
  ${EndIf}
 ${Else}
  DetailPrint "正在启动本机安装向导…"
  ExecWait '"$PLUGINSDIR\source\runtime\node.exe" "$PLUGINSDIR\source\app\packages\installer\cli.mjs" --source "$PLUGINSDIR\source" --target "$INSTDIR"' $Result
 ${EndIf}
 SetErrorLevel $Result
SectionEnd
