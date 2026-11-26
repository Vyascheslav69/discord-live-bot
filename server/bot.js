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
const client = token ? new Client({ intents: [GatewayIntentBits.Guilds] }) : null;

if (client) {
  client.once('clientReady', () => console.log(`Bot conectado como ${client.user.tag}`));
  client.login(token).catch((e) => console.error(`Bot: não consegui entrar no Discord (${e.message}). Confira o token em server/.env.`));
} else {
  console.log('Bot desligado: sem DISCORD_BOT_TOKEN em server/.env');
}

const canPost = (channel) => channel.permissionsFor(channel.guild.members.me)?.has(NEEDED);

// Servidores onde o bot está, com as calls em que ele pode mandar mensagem e criar convite.
export function destinations() {
  if (!client?.isReady()) return [];
  return client.guilds.cache
    .map((g) => ({
      id: g.id,
      name: g.name,
      channels: g.channels.cache
        .filter((c) => c.type === ChannelType.GuildVoice && canPost(c))
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name })),
    }))
    .filter((g) => g.channels.length)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Manda a mensagem no chat da call; devolve a mensagem (para editar quando a transmissão acabar) ou null.
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
  return channel.send({
    content: `🔴 **${escapeMarkdown(name)}** começou a transmitir. Clique para assistir: ${invite.url}`,
    allowedMentions: { parse: [] }, // um nome como "@everyone" não pinga ninguém
  });
}

export async function finish(message, name) {
  await message?.edit({ content: `⚫ ${escapeMarkdown(name)} parou de transmitir.`, allowedMentions: { parse: [] } });
}
