const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const fetch = require('node-fetch');
const { createSelfbot } = require('./bot');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const { startDiscordBot } = require('./discord-bot');
const { solveCaptcha } = require('./captcha-solver');
const Groq = require('groq-sdk');

const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });

const IA_SYSTEM_PROMPT = `Tu es une vraie personne qui discute en français. Tu écris des phrases sensées, cohérentes et bien formulées. Tu réponds toujours directement au sujet du message précédent. Tes réponses font du sens par rapport au contexte de la conversation.
Tu ne te présentes jamais comme un bot ou une IA. Maximum 1 à 2 phrases courtes.`;

async function generateIaReply(history) {
  const res = await groqClient.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: IA_SYSTEM_PROMPT },
      ...history
    ],
    max_tokens: 120,
    temperature: 0.95
  });
  return res.choices[0]?.message?.content?.trim() || null;
}

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

      botInstance.on('invalidated', () => {
        log('error', 'Token invalide ou expire — reconnexion requise.');
        if (activeBots[botToken]) {
          delete userTokenMap[botInstance.user?.id];
          delete activeBots[botToken];
        }
        botInstance = null;
        botToken = null;
        socket.emit('session_expired');
      });

      botInstance.on('error', (err) => {
        if (err.message?.toLowerCase().includes('token')) {
          socket.emit('session_expired');
        }
      });

      attachIaCommands();

      socket.emit('connected', {
        username: botInstance.user.tag,
        avatar: botInstance.user.displayAvatarURL({ format: 'png', size: 128 }),
        id: botInstance.user.id
      });
    } catch (err) {
      log('error', 'Erreur de connexion : ' + (err.message || err));
      socket.emit('login_failed', { message: err.message || 'Token invalide ou refuse.' });
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

  socket.on('dmall', async ({ message, cooldown }) => {
    if (!botInstance) return log('error', 'Bot non connecte. Reconnecte-toi.');
    if (!message || message.trim() === '') return log('error', 'Le message est vide.');
    const delay = Math.max(500, Math.min(30000, parseInt(cooldown) || 2000));
    try {
      const friendIds = botInstance.relationships.cache.filter(type => type === 1);
      const total = friendIds.size;
      if (total === 0) return log('warn', 'Aucun ami trouve sur ce compte.');

      log('info', `Envoi du message a ${total} ami(s) — cooldown : ${delay / 1000}s`);
      let sent = 0, failed = 0, captchaResolved = 0;

      for (const [userId] of friendIds) {
        try {
          const user = await botInstance.users.fetch(userId);
          const dmChannel = await user.createDM();
          await dmChannel.sendTyping().catch(() => {});
          const finalMessage = message.replace(/\{user\}/gi, `@${user.username}`);
          const ok = await sendWithCaptcha(botInstance, dmChannel.id, finalMessage, log);
          if (ok === 'captcha_resolved') { captchaResolved++; sent++; log('success', `DM envoye a ${user.tag} (captcha resolu)`); }
          else if (ok) { sent++; log('success', `DM envoye a ${user.tag}`); }
          else { failed++; log('warn', `Echec pour ${user.tag} — on continue.`); }
          await sleep(delay);
        } catch (e) {
          failed++;
          log('warn', `Echec pour ID ${userId} : ${e.message} — on continue.`);
        }
      }

      log('info', `Termine — ${sent} envoye(s), ${failed} echoue(s), ${captchaResolved} captcha(s) resolu(s).`);
    } catch (err) {
      log('error', 'Erreur dmall : ' + (err.message || err));
    }
  });

  socket.on('dmserver', async ({ guildId, message, cooldown }) => {
    if (!botInstance) return log('error', 'Bot non connecte. Reconnecte-toi.');
    if (!guildId || guildId.trim() === '') return log('error', 'ID de serveur manquant.');
    if (!message || message.trim() === '') return log('error', 'Le message est vide.');
    const delay = Math.max(500, Math.min(120000, parseInt(cooldown) || 70000));

    try {
      const guild = await botInstance.guilds.fetch(guildId).catch(() => null);
      if (!guild) return log('error', 'Serveur introuvable. Verifie l\'ID (le selfbot doit etre dans ce serveur).');

      log('info', `Chargement des membres de "${guild.name}"...`);
      await guild.members.fetch().catch(() => {});

      const members = guild.members.cache.filter(m => !m.user.bot && m.id !== botInstance.user.id);
      const total = members.size;
      if (total === 0) return log('warn', 'Aucun membre trouve dans ce serveur.');

      log('info', `Envoi du message a ${total} membre(s) de "${guild.name}" — cooldown : ${delay / 1000}s`);
      let sent = 0, failed = 0, captchaResolved = 0;

      for (const [, member] of members) {
        const user = member.user;
        try {
          const dmChannel = await user.createDM();
          await dmChannel.sendTyping().catch(() => {});
          const finalMessage = message.replace(/\{user\}/gi, `@${user.username}`);
          const ok = await sendWithCaptcha(botInstance, dmChannel.id, finalMessage, log);
          if (ok === 'captcha_resolved') { captchaResolved++; sent++; log('success', `DM envoye a ${user.tag} (captcha resolu)`); }
          else if (ok) { sent++; log('success', `DM envoye a ${user.tag}`); }
          else if (ok === 'dm_disabled') { failed++; log('warn', `${user.tag} a les DMs desactives — on continue.`); }
          else { failed++; log('warn', `Echec pour ${user.tag} — on continue.`); }
          await sleep(delay);
        } catch (e) {
          failed++;
          log('warn', `Echec pour ${user.tag} : ${e.message} — on continue.`);
        }
      }

      log('info', `Termine — ${sent} envoye(s), ${failed} echoue(s), ${captchaResolved} captcha(s) resolu(s).`);
    } catch (err) {
      log('error', 'Erreur dmserver : ' + (err.message || err));
    }
  });

  let iaListener = null;
  let iaChannelId = null;
  let iaCmdListener = null;
  let iaQueue = [];
  let iaProcessing = false;
  let iaActive = false;
  const iaUserCooldown = new Map();
  const IA_USER_COOLDOWN_MS = 5000;

  async function processIaQueue() {
    if (iaProcessing || iaQueue.length === 0) return;
    iaProcessing = true;

    while (iaQueue.length > 0 && iaActive) {
      const message = iaQueue.shift();
      const now = Date.now();
      const lastReply = iaUserCooldown.get(message.author.id) || 0;
      const timeSince = now - lastReply;
      if (timeSince < IA_USER_COOLDOWN_MS) {
        await sleep(IA_USER_COOLDOWN_MS - timeSince);
      }

      try {
        const cleanContent = message.content.replace(/<@!?[0-9]+>/g, '').trim();
        log('info', `[IA] "${message.author.tag}" : ${cleanContent.substring(0, 60)}`);

        let history = [];
        try {
          const fetched = await message.channel.messages.fetch({ limit: 12, before: message.id });
          const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
          for (const m of sorted) {
            if (!m.content || m.content.trim() === '') continue;
            const text = m.content.replace(/<@!?[0-9]+>/g, '').trim();
            if (m.author.id === botInstance.user.id) {
              history.push({ role: 'assistant', content: text });
            } else {
              history.push({ role: 'user', content: `${m.author.username}: ${text}` });
            }
          }
        } catch (_) {}
        history.push({ role: 'user', content: `${message.author.username}: ${cleanContent || message.content}` });

        const reply = await generateIaReply(history);
        if (!reply) { log('warn', '[IA] Reponse vide — ignoree.'); continue; }

        await message.channel.sendTyping().catch(() => {});
        await sleep(1200 + Math.random() * 1800);

        let sent = false;
        let retries = 0;
        while (!sent && retries < 5) {
          try {
            await message.reply(reply).catch(() => message.channel.send(reply));
            iaUserCooldown.set(message.author.id, Date.now());
            log('success', `[IA] Repondu : ${reply}`);
            sent = true;
          } catch (err) {
            if (err.httpStatus === 429 || (err.message && err.message.includes('rate limit'))) {
              const retryAfter = (err.retryAfter || 5000);
              log('warn', `[IA] Rate limit Discord — attente ${retryAfter}ms avant de reessayer...`);
              await sleep(retryAfter + 500);
              retries++;
            } else {
              log('warn', `[IA] Erreur envoi : ${err.message}`);
              sent = true;
            }
          }
        }
        if (!sent) log('warn', '[IA] Message abandonne apres 5 tentatives (rate limit persistant).');
      } catch (err) {
        log('warn', `[IA] Erreur generation : ${err.message}`);
      }

      await sleep(1500 + Math.random() * 1000);
    }

    iaProcessing = false;
  }

  function startIa(channelId) {
    if (iaListener) {
      botInstance.off('messageCreate', iaListener);
      iaListener = null;
    }
    iaChannelId = channelId;
    iaActive = true;
    iaQueue = [];
    iaProcessing = false;
    iaUserCooldown.clear();

    iaListener = (message) => {
      if (message.channel.id !== iaChannelId) return;
      if (message.author.id === botInstance.user.id) return;
      if (message.author.bot) return;
      if (!message.content || message.content.trim() === '') return;
      if (message.content.startsWith('!ia')) return;

      iaQueue.push(message);
      processIaQueue();
    };

    botInstance.on('messageCreate', iaListener);
    log('success', `[IA] Auto-reply active sur le salon ${iaChannelId}`);
    socket.emit('ia_status', { active: true, channelId: iaChannelId });
  }

  function stopIa() {
    iaActive = false;
    iaQueue = [];
    if (iaListener && botInstance) botInstance.off('messageCreate', iaListener);
    iaListener = null;
    iaChannelId = null;
    iaUserCooldown.clear();
    log('info', '[IA] Auto-reply desactive.');
    socket.emit('ia_status', { active: false });
  }

  function attachIaCommands() {
    if (iaCmdListener) botInstance.off('messageCreate', iaCmdListener);

    iaCmdListener = async (message) => {
      if (message.author.id !== botInstance.user.id) return;
      const content = message.content.trim().toLowerCase();
      if (!content.startsWith('!ia')) return;

      const parts = content.split(/\s+/);
      const sub = parts[1];

      if (sub === 'on') {
        await message.delete().catch(() => {});
        startIa(message.channel.id);
      } else if (sub === 'off') {
        await message.delete().catch(() => {});
        stopIa();
      }
    };

    botInstance.on('messageCreate', iaCmdListener);
  }

  socket.on('ia_start', ({ channelId }) => {
    if (!botInstance) return log('error', 'Bot non connecte. Reconnecte-toi.');
    if (!channelId || !/^\d{17,20}$/.test(channelId.trim())) return log('error', '[IA] ID de salon invalide.');
    startIa(channelId.trim());
  });

  socket.on('ia_stop', () => stopIa());

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

async function sendWithCaptcha(client, channelId, content, log) {
  const DISCORD_API = 'https://discord.com/api/v9';
  const token = client.token;

  const headers = {
    'Authorization': token,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Super-Properties': Buffer.from(JSON.stringify({
      os: 'Windows', browser: 'Chrome', device: '',
      browser_version: '120.0.0.0', os_version: '10'
    })).toString('base64'),
  };

  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content })
    });

    if (res.ok) return true;

    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      const retryAfter = (data.retry_after ? Math.ceil(data.retry_after * 1000) : 5000) + 500;
      if (log) log('warn', `[Rate Limit] Discord bloque l'envoi — attente ${retryAfter}ms...`);
      await sleep(retryAfter);
      const retryRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content })
      });
      if (retryRes.ok) return true;
      const retryData = await retryRes.json().catch(() => ({}));
      if (retryData.retry_after) {
        if (log) log('warn', `[Rate Limit] Toujours bloque apres attente — message abandonne.`);
        return false;
      }
    }

    if (res.status === 403 && data.code === 50007) return 'dm_disabled';

    if (data.captcha_sitekey) {
      if (log) log('info', `[Captcha] Captcha detecte — resolution via Groq IA...`);
      const captchaToken = await solveCaptcha(data.captcha_sitekey, data.captcha_rqdata || null, 'discord.com', log);

      if (!captchaToken) {
        if (log) log('warn', '[Captcha] Echec resolution — on continue quand meme.');
        return false;
      }

      const retryRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { ...headers, 'X-Captcha-Key': captchaToken },
        body: JSON.stringify({ content })
      });

      if (retryRes.ok) return 'captcha_resolved';
      if (log) log('warn', `[Captcha] Echec apres resolution (status ${retryRes.status}) — on continue.`);
      return false;
    }

    return false;
  } catch (e) {
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Selftbot Dashboard running on http://0.0.0.0:${PORT}`);
});
