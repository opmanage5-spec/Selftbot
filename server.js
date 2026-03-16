const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const { createSelfbot } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = {};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.post('/api/connect', async (req, res) => {
  const { token } = req.body;
  if (!token || token.trim() === '') {
    return res.status(400).json({ success: false, error: 'Token manquant.' });
  }
  res.json({ success: true });
});

io.on('connection', (socket) => {
  let botInstance = null;

  const log = (type, msg) => {
    socket.emit('log', { type, msg, time: new Date().toLocaleTimeString('fr-FR') });
  };

  socket.on('start', async ({ token }) => {
    if (!token) return socket.emit('log', { type: 'error', msg: 'Token invalide.', time: '' });

    try {
      log('info', 'Connexion en cours...');
      botInstance = await createSelfbot(token, log);
      socket.emit('connected', {
        username: botInstance.user.tag,
        avatar: botInstance.user.displayAvatarURL({ format: 'png', size: 128 }),
        id: botInstance.user.id
      });
      activeBots[socket.id] = botInstance;
    } catch (err) {
      log('error', 'Erreur de connexion : ' + (err.message || err));
    }
  });

  socket.on('voiceauto', async ({ channelId }) => {
    if (!botInstance) return log('error', 'Bot non connecté.');
    try {
      const channel = await botInstance.channels.fetch(channelId).catch(() => null);
      if (!channel) return log('error', 'Salon vocal introuvable. Vérifie l\'ID.');
      if (channel.type !== 'GUILD_VOICE' && channel.type !== 'GUILD_STAGE_VOICE') {
        return log('error', 'Ce salon n\'est pas un salon vocal.');
      }
      await channel.join();
      log('success', `Connecté au vocal : #${channel.name} (${channel.guild.name})`);
    } catch (err) {
      log('error', 'Erreur voiceauto : ' + (err.message || err));
    }
  });

  socket.on('dmall', async ({ message }) => {
    if (!botInstance) return log('error', 'Bot non connecté.');
    if (!message || message.trim() === '') return log('error', 'Message vide.');
    try {
      const friends = botInstance.relationships.friendCache;
      const total = friends.size;
      if (total === 0) return log('warn', 'Aucun ami trouvé sur ce compte.');
      log('info', `Envoi du message à ${total} ami(s)...`);
      let sent = 0;
      let failed = 0;
      for (const [id, user] of friends) {
        try {
          const dmChannel = await user.createDM();
          await dmChannel.send(message);
          sent++;
          log('success', `DM envoyé à ${user.tag}`);
          await sleep(1200);
        } catch (e) {
          failed++;
          log('warn', `Échec DM pour ${user.tag} : ${e.message}`);
        }
      }
      log('info', `Terminé : ${sent} envoyé(s), ${failed} échoué(s).`);
    } catch (err) {
      log('error', 'Erreur dmall : ' + (err.message || err));
    }
  });

  socket.on('leavevoice', async () => {
    if (!botInstance) return log('error', 'Bot non connecté.');
    try {
      for (const [, guild] of botInstance.guilds.cache) {
        const vc = guild.voiceStates.cache.get(botInstance.user.id);
        if (vc && vc.channel) {
          await vc.channel.leave();
          log('success', `Déconnecté du vocal dans ${guild.name}`);
        }
      }
    } catch (err) {
      log('error', 'Erreur leave voice : ' + (err.message || err));
    }
  });

  socket.on('disconnect', () => {
    if (botInstance) {
      botInstance.destroy();
      delete activeBots[socket.id];
    }
  });
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Selftbot Dashboard running on http://0.0.0.0:${PORT}`);
});
