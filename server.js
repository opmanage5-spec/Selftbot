const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const { createSelfbot } = require('./bot');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const { startDiscordBot } = require('./discord-bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = {};
const userTokenMap = {};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

startDiscordBot(userTokenMap);

io.on('connection', (socket) => {
  let botInstance = null;
  let botToken = null;

  const log = (type, msg) => {
    socket.emit('log', { type, msg, time: new Date().toLocaleTimeString('fr-FR') });
  };

  socket.on('start', async ({ token }) => {
    if (!token || token.trim() === '') {
      return log('error', 'Token manquant ou invalide.');
    }

    if (activeBots[token]) {
      botInstance = activeBots[token];
      botToken = token;
      log('success', `Reconnecte en tant que ${botInstance.user.tag}`);
      return socket.emit('connected', {
        username: botInstance.user.tag,
        avatar: botInstance.user.displayAvatarURL({ format: 'png', size: 128 }),
        id: botInstance.user.id
      });
    }

    try {
      log('info', 'Connexion en cours...');
      botInstance = await createSelfbot(token, log);
      botToken = token;
      activeBots[token] = botInstance;
      userTokenMap[botInstance.user.id] = token;
      socket.emit('connected', {
        username: botInstance.user.tag,
        avatar: botInstance.user.displayAvatarURL({ format: 'png', size: 128 }),
        id: botInstance.user.id
      });
    } catch (err) {
      log('error', 'Erreur de connexion : ' + (err.message || err));
    }
  });

  socket.on('voiceauto', async ({ channelId }) => {
    if (!botInstance) return log('error', 'Bot non connecte. Reconnecte-toi.');
    try {
      const channel = await botInstance.channels.fetch(channelId).catch(() => null);
      if (!channel) return log('error', 'Salon introuvable. Verifie l\'ID.');
      if (channel.type !== 'GUILD_VOICE' && channel.type !== 'GUILD_STAGE_VOICE') {
        return log('error', 'Cet ID ne correspond pas a un salon vocal.');
      }

      const existingConn = getVoiceConnection(channel.guild.id);
      if (existingConn) existingConn.destroy();

      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });

      log('success', `Connecte au vocal : #${channel.name} — ${channel.guild.name}`);
    } catch (err) {
      log('error', 'Erreur voiceauto : ' + (err.message || err));
    }
  });

  socket.on('leavevoice', async () => {
    if (!botInstance) return log('error', 'Bot non connecte.');
    try {
      let count = 0;
      for (const [, guild] of botInstance.guilds.cache) {
        const conn = getVoiceConnection(guild.id);
        if (conn) {
          conn.destroy();
          count++;
          log('success', `Deconnecte du vocal dans ${guild.name}`);
        }
      }
      if (count === 0) log('warn', 'Aucune connexion vocale active.');
    } catch (err) {
      log('error', 'Erreur leave voice : ' + (err.message || err));
    }
  });

  socket.on('dmall', async ({ message }) => {
    if (!botInstance) return log('error', 'Bot non connecte. Reconnecte-toi.');
    if (!message || message.trim() === '') return log('error', 'Le message est vide.');
    try {
      const friendIds = botInstance.relationships.cache.filter(type => type === 1);
      const total = friendIds.size;
      if (total === 0) return log('warn', 'Aucun ami trouve sur ce compte.');

      log('info', `Envoi du message a ${total} ami(s) — mode anti-detection actif...`);
      let sent = 0;
      let failed = 0;
      let captchaHits = 0;

      for (const [userId] of friendIds) {
        try {
          const user = await botInstance.users.fetch(userId);
          const dmChannel = await user.createDM();

          await dmChannel.sendTyping().catch(() => {});
          await sleep(randomBetween(800, 1800));

          const finalMessage = message.replace(/\{user\}/gi, `@${user.username}`);
          await dmChannel.send(finalMessage);
          sent++;
          log('success', `DM envoye a ${user.tag}`);

          const delay = randomBetween(2000, 4500);
          await sleep(delay);

        } catch (e) {
          const msg = (e.message || '').toLowerCase();
          if (msg.includes('captcha') || msg.includes('rate limit') || e.code === 40002 || e.httpStatus === 429) {
            captchaHits++;
            const pause = randomBetween(20000, 40000);
            log('warn', `Captcha/rate-limit detecte — pause de ${Math.round(pause/1000)}s avant de continuer...`);
            await sleep(pause);
            try {
              const dmChannel2 = await user.createDM();
              await dmChannel2.sendTyping().catch(() => {});
              await sleep(randomBetween(1000, 2000));
              const finalMessage = message.replace(/\{user\}/gi, `@${user.username}`);
              await dmChannel2.send(finalMessage);
              sent++;
              log('success', `DM envoye a ${user.tag} (apres pause)`);
              await sleep(randomBetween(3000, 6000));
            } catch (e2) {
              failed++;
              log('warn', `Echec definitif pour ${user.tag} : ${e2.message}`);
            }
          } else {
            failed++;
            log('warn', `Echec pour ID ${userId} : ${e.message}`);
            await sleep(randomBetween(1000, 2000));
          }
        }
      }

      log('info', `Termine — ${sent} envoye(s), ${failed} echoue(s), ${captchaHits} captcha(s) rencontre(s).`);
    } catch (err) {
      log('error', 'Erreur dmall : ' + (err.message || err));
    }
  });

  socket.on('disconnect_bot', () => {
    if (botToken && activeBots[botToken]) {
      if (botInstance && botInstance.user) {
        delete userTokenMap[botInstance.user.id];
      }
      activeBots[botToken].destroy();
      delete activeBots[botToken];
    }
    botInstance = null;
    botToken = null;
  });

  socket.on('disconnect', () => {
  });
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Selftbot Dashboard running on http://0.0.0.0:${PORT}`);
});
