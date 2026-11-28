; Instalador do laele viewer no tema do app: uma tela só (logo, pasta e botão Instalar) e o progresso no mesmo tema.
; Incluído pelo electron-builder (package.json → build.nsis.include). O desinstalador continua o padrão.
; Atualizações rodam este mesmo instalador com /S (sem tela nenhuma) e ele reabre o app (--force-run).

!ifndef BUILD_UNINSTALLER

!include nsDialogs.nsh
!include StrContains.nsh

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

; Sem a pergunta "para todos ou só para mim": instala para o usuário, como antes (perMachine: false).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ${IfNot} ${Silent}
    SetAutoClose true
    HideWindow ; senão a janela do app abre atrás do instalador
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
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

Function laeleBrowse
  Pop $0
  ${NSD_GetText} $laeleDir $1
  nsDialogs::SelectFolderDialog "Escolha onde instalar o laele viewer" $1
  Pop $1
  ${If} $1 != error
    ; sempre numa subpasta com o nome do app ("C:\Jogos" vira "C:\Jogos\laele viewer")
    ${StrContains} $0 "${APP_FILENAME}" $1
    ${If} $0 == ""
      StrCpy $1 "$1\${APP_FILENAME}"
    ${EndIf}
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
  ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
  ${If} $0 == ""
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
FunctionEnd

; ---------- progresso no tema: logo, "Instalando…" e barra roxa, no meio da janela ----------

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
  GetDlgItem $0 $1 1006 ; texto do NSIS (fica vazio): no lugar dele vai um rótulo próprio
  ShowWindow $0 ${SW_HIDE}

  ; logo (96 px) centralizada, acima do meio
  IntOp $6 $5 / 2
  IntOp $6 $6 - 130
  IntOp $9 $4 - 96
  IntOp $9 $9 / 2
  System::Call "user32::CreateWindowEx(i 0, w 'STATIC', w '', i 0x5000000E, i r9, i r6, i 96, i 96, p r1, p 0, p 0, p 0) p .r0"
  System::Call "user32::LoadImage(p 0, w '$PLUGINSDIR\laele-logo.bmp', i 0, i 0, i 0, i 0x10) p .r7"
  SendMessage $0 0x172 0 $7 ; STM_SETIMAGE

  ; "Instalando…" centralizado (SS_CENTER | SS_CENTERIMAGE)
  IntOp $6 $5 / 2
  IntOp $6 $6 - 22
  System::Call "user32::CreateWindowEx(i 0, w 'STATIC', w 'Instalando o laele viewer…', i 0x50000201, i 0, i r6, i r4, i 30, p r1, p 0, p 0, p 0) p .r0"
  SendMessage $0 ${WM_SETFONT} $laeleFontStrong 1
  SetCtlColors $0 ${LAELE_TEXT} transparent

  ; barra: 70% da largura, sem o tema do Windows (senão ignora as cores)
  GetDlgItem $0 $1 1004
  System::Call "uxtheme::SetWindowTheme(p r0, w ' ', w ' ')"
  SendMessage $0 0x409 0 ${LAELE_BAR_COLORREF} ; PBM_SETBARCOLOR
  SendMessage $0 0x2001 0 ${LAELE_TRACK_COLORREF} ; PBM_SETBKCOLOR
  IntOp $6 $4 * 15
  IntOp $6 $6 / 100
  IntOp $7 $4 * 70
  IntOp $7 $7 / 100
  IntOp $8 $5 / 2
  IntOp $8 $8 + 18
  System::Call "user32::SetWindowPos(p r0, p 0, i r6, i r8, i r7, i 8, i 0x14)"
FunctionEnd

!endif
