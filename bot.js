const { Client } = require('discord.js-selfbot-v13');
const { solveCaptcha } = require('./captcha-solver');

function createSelfbot(token, log) {
  return new Promise((resolve, reject) => {
    const client = new Client({
      checkUpdate: false,
      readyStatus: false,
      captchaRetryLimit: 3,
      captchaHandler: async (captchaData, UA, proxy) => {
        log('warn', '[Captcha] Captcha detecte — resolution via Groq AI...');
        const sitekey = captchaData.captcha_sitekey;
        const rqdata = captchaData.captcha_rqdata || null;
        const solved = await solveCaptcha(sitekey, rqdata, 'discord.com', log);
        if (!solved) {
          log('error', '[Captcha] Impossible de resoudre automatiquement. Reessaie dans quelques minutes.');
        }
        return solved;
      }
    });

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Timeout : connexion trop longue. Verifie ton token.'));
    }, 20000);

    client.once('ready', () => {
      clearTimeout(timeout);
      log('success', `Connecte en tant que ${client.user.tag}`);
      resolve(client);
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.login(token).catch((err) => {
      clearTimeout(timeout);
      reject(new Error('Token invalide ou refuse par Discord.'));
    });
  });
}

module.exports = { createSelfbot };
