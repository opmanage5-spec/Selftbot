const { Client } = require('discord.js-selfbot-v13');

function createSelfbot(token, log) {
  return new Promise((resolve, reject) => {
    const client = new Client({
      checkUpdate: false,
      readyStatus: false,
    });

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Timeout : connexion trop longue. Vérifie ton token.'));
    }, 15000);

    client.once('ready', () => {
      clearTimeout(timeout);
      log('success', `Connecté en tant que ${client.user.tag}`);
      resolve(client);
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.login(token).catch((err) => {
      clearTimeout(timeout);
      reject(new Error('Token invalide ou refusé par Discord.'));
    });
  });
}

module.exports = { createSelfbot };
