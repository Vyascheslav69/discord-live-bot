; Instalador do laele viewer no tema do app: uma tela só (logo, pasta e botão Instalar) e o progresso no mesmo tema.
; Incluído pelo electron-builder (package.json → build.nsis.include). O desinstalador continua o padrão.
; Atualização (o app roda este instalador com --updated): em vez de nada ou do instalador, aparece só uma janelinha
; "Atualizando o laele viewer…" no tema, como a do Discord, que fecha sozinha e reabre o app.

!ifndef BUILD_UNINSTALLER

!include nsDialogs.nsh
!include StrContains.nsh
!include FileFunc.nsh

; Cores do app (style.css). SetCtlColors usa RRGGBB; a barra de progresso usa COLORREF (BBGGRR).
!define LAELE_BG 0x12081F
!define LAELE_FIELD 0x1C0F30
!define LAELE_TEXT 0xEDE4FF
!define LAELE_HAZE 0x9A8BB8
!define LAELE_VIOLET 0x8B5CF6
!define LAELE_ORCHID 0xC084FC
!define LAELE_BAR_COLORREF 0xF65C8B
!define LAELE_TRACK_COLORREF 0x300F1C

!define MUI_CUSTOMFUNCTION_GUIINIT laeleGuiInit

Var laeleDir
Var laeleBrowse
Var laeleInstall
Var laeleFontTitle
Var laeleFontText
Var laeleFontStrong
Var laeleUpdating ; "1" quando o app pediu a atualização (--updated)

; ---------- páginas (macros que o modelo do electron-builder chama) ----------

; A tela única entra logo antes do progresso: depois da página "para quem instalar" (que é pulada, mas redefine a
; pasta para a padrão), senão a pasta escolhida seria ignorada. E o progresso ganha o tema ao aparecer.
!macro customPageAfterChangeDir
  Page custom laelePageCreate laelePageLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW laeleProgressShow
!macroend

; Sem página final: ao terminar, o instalador fecha e abre o app.
!macro customFinishPage
!macroend

; --updated: mostra a janelinha de atualização mesmo com /S (o app 1.5.2 ainda pede /S --updated --force-run).
; Instalação silenciosa de verdade (só /S) continua sem tela.
!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $laeleUpdating "1"
    SetSilent normal
  ${EndIf}
!macroend

; Sem a pergunta "para todos ou só para mim": instala para o usuário, como antes (perMachine: false).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ${IfNot} ${Silent}
    SetAutoClose true
    HideWindow ; senão a janela do app abre atrás do instalador
    ; pelo executável, não pelo atalho: na atualização os atalhos não são recriados e podem ter sido apagados
    ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" ""
  ${EndIf}
!macroend

; ---------- janela ----------

!macro laeleHide ID
  GetDlgItem $0 $HWNDPARENT ${ID}
  ShowWindow $0 ${SW_HIDE}
!macroend

; Janela inteira no tema: some o cabeçalho, as linhas, a marca do NSIS e os botões do assistente (o "Avançar" segue
; ativo, escondido, para o Enter funcionar), e a área das páginas ocupa a janela toda.
Function laeleGuiInit
  InitPluginsDir
  SetCtlColors $HWNDPARENT ${LAELE_TEXT} ${LAELE_BG}
  !insertmacro laeleHide 1034
  !insertmacro laeleHide 1035
  !insertmacro laeleHide 1036
  !insertmacro laeleHide 1037
  !insertmacro laeleHide 1038
  !insertmacro laeleHide 1039
  !insertmacro laeleHide 1028
  !insertmacro laeleHide 1256
  !insertmacro laeleHide 1
  !insertmacro laeleHide 2
  !insertmacro laeleHide 3
  ${If} $laeleUpdating == "1"
    ; janelinha de atualização: 320x340, sem barra de título, no meio da tela
    System::Call "user32::GetWindowLong(p $HWNDPARENT, i -16) i .r0"
    IntOp $0 $0 & 0xFF3FFFFF ; sem WS_CAPTION
    System::Call "user32::SetWindowLong(p $HWNDPARENT, i -16, i r0)"
    System::Call "user32::GetSystemMetrics(i 0) i .r1"
    System::Call "user32::GetSystemMetrics(i 1) i .r2"
    IntOp $1 $1 - 320
    IntOp $1 $1 / 2
    IntOp $2 $2 - 340
    IntOp $2 $2 / 2
    System::Call "user32::SetWindowPos(p $HWNDPARENT, p 0, i r1, i r2, i 320, i 340, i 0x24)"
  ${EndIf}
  System::Call "*(i,i,i,i) p .r1"
  System::Call "user32::GetClientRect(p $HWNDPARENT, p r1)"
  System::Call "*$1(i, i, i .r2, i .r3)"
  System::Free $1
  GetDlgItem $0 $HWNDPARENT 1018
  System::Call "user32::SetWindowPos(p r0, p 0, i 0, i 0, i r2, i r3, i 0x14)"
  CreateFont $laeleFontTitle "Segoe UI Semibold" 20 600
  CreateFont $laeleFontText "Segoe UI" 10 400
  CreateFont $laeleFontStrong "Segoe UI Semibold" 11 600
  File /oname=$PLUGINSDIR\laele-logo.bmp "${BUILD_RESOURCES_DIR}\instalador-logo.bmp"
FunctionEnd

; Texto centralizado, com fonte e cores.
!macro laeleLabel X Y W H TEXT FONT COLOR
  nsDialogs::CreateControl STATIC ${__NSD_Label_STYLE}|${SS_CENTER}|${SS_CENTERIMAGE} ${__NSD_Label_EXSTYLE} ${X} ${Y} ${W} ${H} "${TEXT}"
  Pop $0
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  SetCtlColors $0 ${COLOR} transparent
!macroend

; ---------- tela única: logo, nome, pasta e Instalar ----------

Function laelePageCreate
  ${If} $laeleUpdating == "1"
    Abort ; atualização: vai direto para o progresso, na mesma pasta
  ${EndIf}
  !insertmacro laeleHide 3
  nsDialogs::Create 1018
  Pop $1
  ${If} $1 == error
    Abort
  ${EndIf}
  SetCtlColors $1 ${LAELE_TEXT} ${LAELE_BG}

  ; logo do tamanho exato da imagem (96 px), centralizada: o controle de imagem não aceita cor de fundo
  System::Call "*(i,i,i,i) p .r3"
  System::Call "user32::GetClientRect(p r1, p r3)"
  System::Call "*$3(i, i, i .r4, i)"
  System::Free $3
  IntOp $4 $4 - 96
  IntOp $4 $4 / 2
  nsDialogs::CreateControl STATIC ${__NSD_Bitmap_STYLE} ${__NSD_Bitmap_EXSTYLE} $4 16u 96 96 ""
  Pop $0
  ${NSD_SetImage} $0 $PLUGINSDIR\laele-logo.bmp $2

  !insertmacro laeleLabel 0 72u 100% 20u "laele viewer" $laeleFontTitle ${LAELE_TEXT}
  !insertmacro laeleLabel 0 93u 100% 12u "Transmita sua tela para a atividade do Discord" $laeleFontText ${LAELE_HAZE}

  ${NSD_CreateLabel} 10% 120u 80% 11u "Pasta de instalação"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $laeleFontText 1
  SetCtlColors $0 ${LAELE_HAZE} transparent

  ${NSD_CreateText} 10% 133u 62% 14u $INSTDIR
  Pop $laeleDir
  SendMessage $laeleDir ${WM_SETFONT} $laeleFontText 1
  SetCtlColors $laeleDir ${LAELE_TEXT} ${LAELE_FIELD}

  !insertmacro laeleLabel 74% 133u 16% 14u "Alterar…" $laeleFontStrong ${LAELE_ORCHID}
  StrCpy $laeleBrowse $0
  ${NSD_OnClick} $laeleBrowse laeleBrowse

  ; "Botão" desenhado como texto clicável: botões do Windows não aceitam cor.
  !insertmacro laeleLabel 32% 162u 36% 22u "Instalar" $laeleFontStrong 0xFFFFFF
  StrCpy $laeleInstall $0
  SetCtlColors $laeleInstall 0xFFFFFF ${LAELE_VIOLET}
  ${NSD_OnClick} $laeleInstall laeleInstall

  ${NSD_SetFocus} $laeleDir
  nsDialogs::Show
  ${NSD_FreeImage} $2
FunctionEnd

; Sempre numa subpasta com o nome do app: "C:\Jogos" vira "C:\Jogos\laele viewer" e "D:\" vira "D:\laele viewer"
; (sem barra dupla: a raiz do disco já termina em "\").
!macro laeleAppDir VAR
  ${StrContains} $0 "${APP_FILENAME}" ${VAR}
  ${If} $0 == ""
    StrCpy $0 ${VAR} 1 -1
    ${If} $0 == "\"
      StrCpy ${VAR} ${VAR} -1
    ${EndIf}
    StrCpy ${VAR} "${VAR}\${APP_FILENAME}"
  ${EndIf}
!macroend

Function laeleBrowse
  Pop $0
  ${NSD_GetText} $laeleDir $1
  nsDialogs::SelectFolderDialog "Escolha onde instalar o laele viewer" $1
  Pop $1
  ${If} $1 != error
    !insertmacro laeleAppDir $1
    ${NSD_SetText} $laeleDir $1
  ${EndIf}
FunctionEnd

Function laeleInstall
  Pop $0
  SendMessage $HWNDPARENT 0x408 1 0 ; próxima página (passa por laelePageLeave)
FunctionEnd

Function laelePageLeave
  ${NSD_GetText} $laeleDir $INSTDIR
  ${If} $INSTDIR == ""
    MessageBox MB_ICONEXCLAMATION "Escolha uma pasta para instalar."
    Abort
  ${EndIf}
  !insertmacro laeleAppDir $INSTDIR
FunctionEnd

; ---------- progresso no tema: logo, título, barra em pílula e uma frase, centralizados na janela ----------

Function laeleProgressShow
  ; o NSIS mostra os botões de novo a cada página
  !insertmacro laeleHide 1
  !insertmacro laeleHide 2
  !insertmacro laeleHide 3
  ; a página de progresso vem do tamanho original: estica para a janela toda
  System::Call "*(i,i,i,i) p .r3"
  System::Call "user32::GetClientRect(p $HWNDPARENT, p r3)"
  System::Call "*$3(i, i, i .r4, i .r5)"
  System::Free $3
  FindWindow $1 "#32770" "" $HWNDPARENT
  System::Call "user32::SetWindowPos(p r1, p 0, i 0, i 0, i r4, i r5, i 0x14)"
  SetCtlColors $1 ${LAELE_TEXT} ${LAELE_BG}

  GetDlgItem $0 $1 1016 ; lista de detalhes
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $1 1027 ; botão "mostrar detalhes"
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $1 1006 ; texto do NSIS (fica vazio): no lugar dele vão rótulos próprios
  ShowWindow $0 ${SW_HIDE}

  ; bloco de 192 px no meio da janela: logo 96, título 26, barra 8 e frase 20, com respiros
  IntOp $6 $5 - 192
  IntOp $6 $6 / 2 ; topo do bloco

  ; logo
  IntOp $9 $4 - 96
  IntOp $9 $9 / 2
  System::Call "user32::CreateWindowEx(i 0, w 'STATIC', w '', i 0x5000000E, i r9, i r6, i 96, i 96, p r1, p 0, p 0, p 0) p .r0"
  System::Call "user32::LoadImage(p 0, w '$PLUGINSDIR\laele-logo.bmp', i 0, i 0, i 0, i 0x10) p .r7"
  SendMessage $0 0x172 0 $7 ; STM_SETIMAGE

  ; título
  StrCpy $R2 "Instalando o laele viewer…"
  StrCpy $R3 "Leva só alguns segundos"
  ${If} $laeleUpdating == "1"
    StrCpy $R2 "Atualizando o laele viewer…"
    StrCpy $R3 "O app abre de novo sozinho"
  ${EndIf}
  IntOp $8 $6 + 112
  System::Call "user32::CreateWindowEx(i 0, w 'STATIC', w R2, i 0x50000201, i 0, i r8, i r4, i 26, p r1, p 0, p 0, p 0) p .r0"
  SendMessage $0 ${WM_SETFONT} $laeleFontStrong 1
  SetCtlColors $0 ${LAELE_TEXT} transparent

  ; frase pequena embaixo da barra
  IntOp $8 $6 + 166
  System::Call "user32::CreateWindowEx(i 0, w 'STATIC', w R3, i 0x50000201, i 0, i r8, i r4, i 20, p r1, p 0, p 0, p 0) p .r0"
  SendMessage $0 ${WM_SETFONT} $laeleFontText 1
  SetCtlColors $0 ${LAELE_HAZE} transparent

  ; barra em pílula: sem o tema do Windows (senão ignora as cores), sem borda, preenchimento contínuo e cantos
  ; arredondados recortados com uma região (o controle do Windows não tem cantos redondos)
  GetDlgItem $0 $1 1004
  System::Call "uxtheme::SetWindowTheme(p r0, w ' ', w ' ')"
  System::Call "user32::GetWindowLong(p r0, i -16) i .r7"
  IntOp $7 $7 & 0xFF7FFFFF ; sem WS_BORDER
  IntOp $7 $7 | 1 ; PBS_SMOOTH
  System::Call "user32::SetWindowLong(p r0, i -16, i r7)"
  System::Call "user32::GetWindowLong(p r0, i -20) i .r7"
  IntOp $7 $7 & 0xFFFDFDFF ; sem WS_EX_CLIENTEDGE e WS_EX_STATICEDGE
  System::Call "user32::SetWindowLong(p r0, i -20, i r7)"
  SendMessage $0 0x409 0 ${LAELE_BAR_COLORREF} ; PBM_SETBARCOLOR
  SendMessage $0 0x2001 0 ${LAELE_TRACK_COLORREF} ; PBM_SETBKCOLOR
  IntOp $9 $4 * 60
  IntOp $9 $9 / 100 ; largura: 60% da janela
  IntOp $3 $4 - $9
  IntOp $3 $3 / 2 ; x centralizado
  IntOp $8 $6 + 148
  System::Call "user32::SetWindowPos(p r0, p 0, i r3, i r8, i r9, i 8, i 0x34)" ; 0x20: aplica a troca de borda
  IntOp $7 $9 + 1
  System::Call "gdi32::CreateRoundRectRgn(i 0, i 0, i r7, i 9, i 8, i 8) p .r7"
  System::Call "user32::SetWindowRgn(p r0, p r7, i 1)"
FunctionEnd

!endif
