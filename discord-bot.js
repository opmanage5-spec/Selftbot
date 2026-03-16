const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

function startDiscordBot(userTokenMap) {
  const BOT_TOKEN = process.env.BOT_TOKEN;

  if (!BOT_TOKEN) {
    console.log('[DiscordBot] BOT_TOKEN non defini — bot Discord desactive.');
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    console.log(`[DiscordBot] Connecte en tant que ${client.user.tag}`);

    const commands = [
      new SlashCommandBuilder()
        .setName('token')
        .setDescription('Affiche ton token Discord selfbot (visible seulement par toi)')
        .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('[DiscordBot] Commande /token enregistree.');
    } catch (err) {
      console.error('[DiscordBot] Erreur enregistrement commandes :', err.message);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'token') {
      const userId = interaction.user.id;
      const token = userTokenMap[userId];

      if (!token) {
        return interaction.reply({
          content:
            '**Aucun token associe.**\n' +
            'Connecte-toi d\'abord sur le dashboard Selftbot, puis reessaie.',
          ephemeral: true
        });
      }

      return interaction.reply({
        content:
          '**Ton token Discord :**\n' +
          '```\n' + token + '\n```\n' +
          '> Ne partage **jamais** ce token avec quelqu\'un d\'autre !',
        ephemeral: true
      });
    }
  });

  client.login(BOT_TOKEN).catch((err) => {
    console.error('[DiscordBot] Erreur connexion :', err.message);
  });
}

module.exports = { startDiscordBot };
