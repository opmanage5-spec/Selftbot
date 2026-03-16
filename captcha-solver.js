const Groq = require('groq-sdk');
const fetch = require('node-fetch');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const HCAPTCHA_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': HCAPTCHA_USER_AGENT,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  return res.json();
}

async function imageUrlToBase64(url) {
  const res = await fetch(url, { headers: { 'User-Agent': HCAPTCHA_USER_AGENT } });
  const buf = await res.buffer();
  return buf.toString('base64');
}

async function classifyImageWithGroq(imageBase64, label) {
  try {
    const response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`
              }
            },
            {
              type: 'text',
              text: `Does this image clearly contain a "${label}"? Answer ONLY with "true" or "false". No explanation.`
            }
          ]
        }
      ],
      max_tokens: 5,
      temperature: 0
    });

    const answer = response.choices[0]?.message?.content?.trim().toLowerCase() || 'false';
    return answer.includes('true');
  } catch {
    return false;
  }
}

async function solveCaptcha(sitekey, rqdata, host = 'discord.com', log) {
  try {
    if (log) log('info', '[Captcha] Tentative de resolution automatique via Groq...');

    const configUrl = `https://hcaptcha.com/checksiteconfig?v=1&host=${host}&sitekey=${sitekey}&sc=1&swa=1`;
    const config = await fetchJson(configUrl).catch(() => null);
    if (!config) throw new Error('Impossible de charger la config hCaptcha');

    const hsw = config.c?.req || '';

    const taskPayload = {
      v: '1',
      sitekey,
      host,
      hl: 'fr',
      motionData: JSON.stringify({
        st: Date.now(),
        dct: Date.now(),
        mm: [[100, 200, Date.now()]]
      }),
      n: hsw,
      c: JSON.stringify({ type: 'hsw', req: hsw })
    };

    if (rqdata) taskPayload.rqdata = rqdata;

    const taskRes = await fetchJson(`https://hcaptcha.com/getcaptcha/${sitekey}`, {
      method: 'POST',
      body: JSON.stringify(taskPayload)
    }).catch(() => null);

    if (!taskRes || !taskRes.tasklist) {
      throw new Error('Pas de tache retournee par hCaptcha');
    }

    const { tasklist, key, requester_question } = taskRes;
    const label = (requester_question?.en || '').toLowerCase();

    if (log) log('info', `[Captcha] Tache : "${label}" — ${tasklist.length} image(s) a analyser`);

    const answers = {};
    await Promise.all(tasklist.map(async (task) => {
      try {
        const base64 = await imageUrlToBase64(task.datapoint_uri);
        const result = await classifyImageWithGroq(base64, label);
        answers[task.task_key] = result ? 'true' : 'false';
      } catch {
        answers[task.task_key] = 'false';
      }
    }));

    const submitPayload = {
      v: '1',
      job_mode: taskRes.request_type,
      answers,
      serverdomain: host,
      sitekey,
      motionData: JSON.stringify({
        st: Date.now(),
        dct: Date.now(),
        mm: [[150, 250, Date.now()]]
      }),
      n: hsw,
      c: JSON.stringify({ type: 'hsw', req: hsw })
    };

    const submitRes = await fetchJson(`https://hcaptcha.com/checkcaptcha/${sitekey}/${key}`, {
      method: 'POST',
      body: JSON.stringify(submitPayload)
    }).catch(() => null);

    if (!submitRes) throw new Error('Echec soumission captcha');

    if (submitRes.pass && submitRes.generated_pass_UUID) {
      if (log) log('success', '[Captcha] Captcha resolu automatiquement !');
      return submitRes.generated_pass_UUID;
    }

    throw new Error(`hCaptcha rejete la reponse (pass: ${submitRes.pass})`);
  } catch (err) {
    if (log) log('warn', `[Captcha] Echec resolution : ${err.message}`);
    return null;
  }
}

module.exports = { solveCaptcha };
