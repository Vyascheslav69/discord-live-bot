# laele viewer — transmissão de tela na atividade do Discord

```
[laele viewer] --WebSocket (H.264/VP8 + Opus) + senha--> [Vite :5173] --> [relay :8787] --> atividade no Discord
                                                            ^ túnel Cloudflare (único endereço público)
```

- `broadcaster/` — o **laele viewer**: app desktop para transmitir. Na primeira vez pede seu nome, o endereço do servidor e a senha, e guarda tudo para as próximas vezes. Você escolhe a tela ou janela e a qualidade (1080p/720p/480p, 30/60 fps), e transmite com o som do PC, **menos o som do Discord** (evita eco).
- `server/` — o **relay** e o **bot**: recebe o vídeo já codificado de cada laele viewer e repassa para quem está assistindo. Confere a senha, não deixa dois nomes iguais e avisa no Discord quando alguém começa a transmitir.
- `activity/` — a página que roda dentro do Discord. Mostra quem está transmitindo, troca de tela, mostra duas lado a lado, tem volume por tela e tela cheia (botão ou duplo clique).
- `SENHA-TRANSMISSOR.txt` — a senha para transmitir (linha 2). **Não vai para o GitHub.** Num computador novo, copie `SENHA-TRANSMISSOR.example.txt` e troque a senha.

**Nomes únicos**: duas pessoas não transmitem com o mesmo nome. "Júlia", "julia" e "JULIA" contam como o mesmo. Quando alguém para de transmitir, o nome fica livre na hora.

**Atraso**: o vídeo vai por WebSocket, que funciona dentro do Discord. O Discord bloqueia WebRTC nas atividades, e o HLS ficava com segundos de atraso. Medido pelo proxy do Discord: ~30 ms do laele viewer até a atividade, mais a captura e a decodificação. Se a rede engasga, quadros atrasados são descartados em vez de acumular atraso.

**Não precisa abrir porta no roteador**: tudo passa pelo túnel.

## Instalar o laele viewer (quem vai transmitir)

| Sistema | Vídeo | Som do PC (sem o Discord) | Arquivo em **Releases** |
|---|---|---|---|
| Windows 10/11 | ✅ | ✅ | `laele-viewer-setup-<versão>.exe` |
| Linux (x64, PipeWire) | ✅ | ✅ | `laele-viewer-<versão>-linux-x64.AppImage` |
| Mac | ✅ | ❌ só vídeo | `…-mac-arm64.dmg` (chip Apple) ou `…-mac-x64.dmg` (Intel) |

1. Baixe o arquivo do seu sistema em **Releases** do repositório.
2. Instale. Não precisa de Node nem de mais nada.
   - **Windows**: abra o `.exe`, que instala sozinho e cria um atalho na área de trabalho. Se aparecer "O Windows protegeu o computador" (o app não tem assinatura digital paga), clique em **Mais informações → Executar assim mesmo**.
   - **Mac**: abra o `.dmg` e arraste o app para Aplicativos. Na primeira vez, clique com o botão direito no app → **Abrir** (o app não tem assinatura da Apple). Depois libere em Ajustes do Sistema → Privacidade e Segurança → **Gravação de Tela** e abra o app de novo.
   - **Linux**: `chmod +x laele-viewer-*.AppImage` e abra. Se não abrir, instale `libfuse2`. No Wayland, quem escolhe a tela é o seletor do sistema. Sem codificador H.264, o app usa VP8, que pesa mais no processador em 1080p60.
3. Na primeira vez, preencha:
   - **Seu nome**: é o que aparece na atividade.
   - **Endereço do servidor**: no PC do servidor, `http://localhost:5173`. Nos outros, o endereço do túnel que o dono do servidor passar.
   - **Senha**: a de `SENHA-TRANSMISSOR.txt`, que o dono do servidor passa.
4. Escolha a tela ou janela e a qualidade e clique em **Transmitir**. No canto superior direito aparecem o servidor e a call onde o bot vai avisar. Clique ali para trocar.

Para trocar nome, endereço ou senha depois, use "Alterar nome, endereço ou senha".

### Log (para entender erros em outros computadores)

O app grava tudo o que acontece num arquivo: versão e sistema, cada tentativa de transmitir, qualidade e codec escolhidos, captura de som, quedas de conexão e erros. Senhas não vão para o log. Peça para a pessoa clicar em **Abrir logs** no app e te mandar o `laele-viewer.log`:

- Windows: `%APPDATA%\laele viewer\logs`
- Mac: `~/Library/Logs/laele viewer`
- Linux: `~/.config/laele viewer/logs`

Quando passa de 1 MB, o arquivo atual vira `laele-viewer.old.log` e começa um novo.

### Gerar os instaladores

Ao enviar uma tag de versão, o GitHub Actions gera os instaladores dos três sistemas e anexa à Release (`.github/workflows/instaladores.yml`):

```powershell
git tag v1.1.0; git push origin v1.1.0
```
Para gerar só o do seu sistema: `cd broadcaster; npm i; npm run dist` (sai em `broadcaster/dist/`). Para rodar sem instalar: `npm start`.

## Servidor (um PC fica ligado para todos)

### 1. Instalar uma vez

1. **Node.js** 20 ou mais novo.
2. **cloudflared**: `winget install Cloudflare.cloudflared`
3. Dependências:
   ```powershell
   cd server; npm i; cd ..\activity; npm i
   ```
4. Senha: copie `SENHA-TRANSMISSOR.example.txt` para `SENHA-TRANSMISSOR.txt` e escreva a senha na linha 2.

### 2. Criar a atividade no Discord

1. https://discord.com/developers/applications → **New Application** → dê um nome (é o que aparece na lista de atividades).
2. Em **General Information**, copie o **Application ID** e crie `activity/.env` (veja `activity/.env.example`):
   ```
   VITE_DISCORD_CLIENT_ID=seu_id_aqui
   ```
   Reinicie o `npm start` da atividade depois de criar o arquivo.
3. **Activities → Settings**: ative **Enable Activities**. Se pedir, marque as plataformas (Desktop; Web/Mobile se quiser).
4. **Activities → URL Mappings**: em `/` (Root Mapping), coloque o host do túnel **sem** `https://`, ex.: `abc-def.trycloudflare.com`.
5. **App Testers**: adicione seus amigos pelo nome de usuário. Eles precisam aceitar o convite (chega por e-mail ou DM). Enquanto o app não é verificado, só você e os testers conseguem abrir a atividade: é isso que a mantém privada.
6. **Installation**: em *Installation Contexts* deixe **Guild Install**, copie o *Install Link*, abra-o e adicione o app ao seu servidor.

### 3. Bot que avisa quando alguém transmite

O bot manda no chat da call escolhida algo como "🔴 **Juan** começou a transmitir. Clique para assistir", com um link que abre a atividade naquela call. Quando a transmissão acaba, a mensagem muda para "parou de transmitir". O Discord não deixa bots abrirem a atividade sozinhos, por isso o link.

1. No portal, em **Bot**, clique em **Reset Token** e copie o token. **Não mande para ninguém**: quem tem o token controla o bot.
2. Copie `server/.env.example` para `server/.env` e cole o token depois de `DISCORD_BOT_TOKEN=`.
3. Adicione o bot a cada servidor onde ele vai avisar, abrindo este link (permissões: ver canais, mandar mensagens, inserir links, criar convite):
   https://discord.com/oauth2/authorize?client_id=1575533587091034112&scope=bot&permissions=19457
4. Reinicie o relay (`cd server; npm start`). O terminal deve mostrar "Bot conectado como …".

No laele viewer, só aparecem as calls em que o bot tem permissão para mandar mensagem e criar convite. Dá para escolher "Não avisar no Discord".

### 4. Rodar (cada um num terminal, a partir desta pasta)

```powershell
cd server; npm start
```
```powershell
cd activity; npm start
```
```powershell
cloudflared tunnel --url http://localhost:5173
```
O cloudflared mostra um endereço tipo `https://abc-def.trycloudflare.com`. **Ele muda toda vez que o túnel reinicia.** Quando isso acontecer, atualize o URL Mapping no portal e avise quem transmite de fora.

Para conferir o relay: `cd server; npm test`.

## Assistir

Entre num canal de voz do servidor → ícone de atividades (🚀) → escolha o app. Ou clique no link que o bot mandou.

- A barra de baixo lista quem está transmitindo. Clique num nome para mostrá-lo na tela selecionada (a de borda mais clara).
- O botão à direita alterna entre uma e duas telas.
- Passe o mouse sobre uma tela para ver o som e a tela cheia. O vídeo começa mudo (regra de autoplay). Esc sai da tela cheia.

Teste sem Discord: abra http://localhost:5173 (ou o endereço do túnel) no navegador.

## Levar o servidor para outro computador

Clone o repositório no outro PC, instale Node.js e cloudflared e siga a seção "Servidor". Copie também `SENHA-TRANSMISSOR.txt`, `server/.env` e `activity/.env`, que não vão para o GitHub. Depois atualize o URL Mapping no portal e o endereço do servidor no laele viewer de cada um.

## Problemas comuns

- **"Senha errada"**: confira `SENHA-TRANSMISSOR.txt` (e reinicie o relay se ela foi trocada).
- **"Não achei o servidor"**: o túnel reiniciou e o endereço mudou, ou o relay/atividade não está rodando.
- **"Este aparelho não consegue mostrar vídeo …"**: o navegador de quem assiste não decodifica o codec escolhido pelo laele viewer.
- **Eco do Discord mesmo assim**: a exclusão vale para o app desktop do Discord. Discord aberto no navegador não é excluído.
- **Seletor diz "Bot do Discord fora do ar"**: falta o token em `server/.env`, o token está errado (veja o terminal do relay) ou o bot não foi adicionado a nenhum servidor.
- **Atividade em branco no Discord**: URL Mapping desatualizado ou Activities desativado.
- **Endereço fixo**: use um túnel nomeado do Cloudflare (precisa de domínio) ou o domínio estático grátis do ngrok, e adicione o host em `allowedHosts` no `activity/vite.config.js`.
