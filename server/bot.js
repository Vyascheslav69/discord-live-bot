// Bot do Discord: avisa no chat de uma call quando alguém começa a transmitir, com o link que abre a atividade.
// Bots não conseguem abrir atividades sozinhos; o convite com target_type "embedded application" abre a atividade
// naquela call com um clique. Sem DISCORD_BOT_TOKEN (server/.env) o relay funciona sem avisos.
import { ChannelType, Client, GatewayIntentBits, InviteTargetType, PermissionFlagsBits, escapeMarkdown } from 'discord.js';

const NEEDED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreateInstantInvite];

try {
  process.loadEnvFile(new URL('.env', import.meta.url)); // não sobrescreve variáveis já definidas
} catch {
  // sem server/.env: bot desligado
}
const token = process.env.DISCORD_BOT_TOKEN;
// GuildVoiceStates (não é privilegiada): saber em que call cada pessoa está.
const client = token ? new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] }) : null;

if (client) {
  client.once('clientReady', () => console.log(`Bot conectado como ${client.user.tag}`));
  client.login(token).catch((e) => console.error(`Bot: não consegui entrar no Discord (${e.message}). Confira o token em server/.env.`));
} else {
  console.log('Bot desligado: sem DISCORD_BOT_TOKEN em server/.env');
}

const canPost = (channel) => channel.permissionsFor(channel.guild.members.me)?.has(NEEDED);

export const enabled = !!client; // há token (o bot pode estar conectando ou caído)
export const ready = () => !!client?.isReady();
export const applicationId = () => client?.application?.id;

// Quem é a pessoa no Discord: o apelido no servidor e a call em que ela está (servidor da call primeiro;
// fora de call, o primeiro servidor onde ela está). null se ela não está em nenhum servidor do bot.
export async function member(userId) {
  if (!ready()) return null;
  const guilds = [...client.guilds.cache.values()];
  const inCall = guilds.find((g) => g.voiceStates.cache.get(userId)?.channelId);
  for (const g of inCall ? [inCall, ...guilds] : guilds) {
    const m = await g.members.fetch({ user: userId, force: true }).catch(() => null); // force: apelido atualizado
    if (m) return { name: m.displayName, channel: m.voice.channel ?? null, avatar: m.displayAvatarURL({ extension: 'png', size: 64, forceStatic: true }) };
  }
  return null;
}

// Avisos somem do chat depois de 2 minutos (o bot apaga as próprias mensagens; não precisa de permissão extra).
// shortcut: o timer vive no processo; se o relay reiniciar antes, a mensagem fica. Para garantir, guardar e apagar ao iniciar.
const NOTICE_TTL = 2 * 60_000;
const temporary = (message) => setTimeout(() => message.delete().catch(() => {}), NOTICE_TTL);

// Manda o aviso no chat da call; devolve a mensagem (o canal é usado no aviso de fim) ou null.
export async function announce(name, guildId, channelId) {
  if (!client?.isReady() || !channelId) return null;
  const channel = client.channels.cache.get(channelId);
  if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildVoice || !canPost(channel)) return null;
  const invite = await channel.createInvite({
    targetType: InviteTargetType.EmbeddedApplication,
    targetApplication: client.application.id,
    maxAge: 0,
    unique: false,
  });
  const message = await channel.send({
    content: `🔴 **${escapeMarkdown(name)}** começou a transmitir. Clique para assistir: ${invite.url}`,
    allowedMentions: { parse: [] }, // um nome como "@everyone" não pinga ninguém
  });
  temporary(message);
  return message;
}

export async function finish(message, name) {
  if (!message) return;
  temporary(await message.channel.send({ content: `⚫ ${escapeMarkdown(name)} parou de transmitir.`, allowedMentions: { parse: [] } }));
}
