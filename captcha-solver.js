const Groq = require('groq-sdk');
const fetch = require('node-fetch');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function imageToBase64(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://discord.com/' }
  });
  const buf = await res.buffer();
  const mime = res.headers.get('content-type') || 'image/jpeg';
  return { base64: buf.toString('base64'), mime };
}

async function classifyImage(imageBase64, mime, label) {
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.2-11b-vision-preview',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${imageBase64}` }
          },
          {
            type: 'text',
            text: `Look at this image carefully. Does it contain "${label}"? Reply ONLY "yes" or "no".`
          }
        ]
      }],
      max_tokens: 3,
      temperature: 0
    });
    const answer = (res.choices[0]?.message?.content || '').toLowerCase().trim();
    return answer.startsWith('yes');
  } catch (err) {
    return false;
  }
}

async function getHcaptchaTask(sitekey, rqdata, host, log) {
  const versions = ['3', '2', '1'];
  for (const v of versions) {
    try {
      const payload = {
        v,
        sitekey,
        host,
        hl: 'en',
        motionData: JSON.stringify({
          st: Date.now(),
          dct: Date.now() - Math.floor(Math.random() * 500),
          mm: Array.from({ length: 8 }, (_, i) => [
            Math.floor(Math.random() * 500),
            Math.floor(Math.random() * 500),
            Date.now() - (8 - i) * 100
          ])
        })
      };
      if (rqdata) payload.rqdata = rqdata;

      const res = await fetch(`https://hcaptcha.com/getcaptcha/${sitekey}`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          'Origin': `https://${host}`,
          'Referer': `https://${host}/`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => null);
      if (data && data.tasklist && data.tasklist.length > 0) {
        if (log) log('info', `[Captcha] Tache obtenue (v${v}) : "${data.requester_question?.en}" — ${data.tasklist.length} images`);
        return data;
      }
    } catch {}
  }
  return null;
}

async function submitAnswers(sitekey, key, requestType, answers, host) {
  try {
    const res = await fetch(`https://hcaptcha.com/checkcaptcha/${sitekey}/${key}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Origin': `https://${host}`,
        'Referer': `https://${host}/`
      },
      body: JSON.stringify({
        v: '3',
        job_mode: requestType,
        answers,
        serverdomain: host,
        sitekey,
        motionData: JSON.stringify({
          st: Date.now(),
          dct: Date.now() - 200,
          mm: [[200, 300, Date.now()]]
        })
      })
    });
    return res.json().catch(() => null);
  } catch {
    return null;
  }
}

async function solveCaptcha(sitekey, rqdata, host = 'discord.com', log) {
  if (log) log('info', '[Captcha] Resolution via Groq IA en cours...');

  try {
    const taskData = await getHcaptchaTask(sitekey, rqdata, host, log);

    if (!taskData) {
      if (log) log('warn', '[Captcha] Impossible d\'obtenir les images du captcha — on continue sans resoudre.');
      return null;
    }

    const { tasklist, key, request_type, requester_question } = taskData;
    const label = (requester_question?.en || '').toLowerCase();

    const answers = {};
    await Promise.all(tasklist.map(async (task) => {
      try {
        const { base64, mime } = await imageToBase64(task.datapoint_uri);
        const result = await classifyImage(base64, mime, label);
        answers[task.task_key] = result ? 'true' : 'false';
      } catch {
        answers[task.task_key] = 'false';
      }
    }));

    if (log) log('info', `[Captcha] Reponses envoyees a hCaptcha...`);

    const submitRes = await submitAnswers(sitekey, key, request_type, answers, host);

    if (submitRes?.pass && submitRes?.generated_pass_UUID) {
      if (log) log('success', '[Captcha] Captcha resolu avec succes !');
      return submitRes.generated_pass_UUID;
    }

    if (log) log('warn', `[Captcha] hCaptcha a refuse les reponses — on continue quand meme.`);
    return null;

  } catch (err) {
    if (log) log('warn', `[Captcha] Erreur inattendue : ${err.message} — on continue.`);
    return null;
  }
}

module.exports = { solveCaptcha };
