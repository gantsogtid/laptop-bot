const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// Environment variables-аас уншина (Railway дээр тохируулна)
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'laptop-bot-verify';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Зарахад бэлэн';
const FAQ_SHEET_NAME = process.env.FAQ_SHEET_NAME || 'Bot_FAQ';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');

// Google Sheets
const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Cache
let laptopCache = { data: [], lastUpdate: 0 };
let faqCache = { data: [], lastUpdate: 0 };
const CACHE_TTL = 5 * 60 * 1000;

async function getReadyLaptops() {
  const now = Date.now();
  if (laptopCache.data.length > 0 && now - laptopCache.lastUpdate < CACHE_TTL) {
    return laptopCache.data;
  }
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:I200`,
    });
    const rows = res.data.values || [];
    if (rows.length < 2) return [];
    const laptops = rows.slice(1).map(row => ({
      model: row[1] || '',
      cpu: row[2] || '',
      gen: row[3] || '',
      ram: row[4] || '',
      ssd: row[5] || '',
      screen: row[6] || '',
      price: row[7] || '',
      botResponse: row[8] || '',
    })).filter(l => l.model);
    laptopCache = { data: laptops, lastUpdate: now };
    console.log(`Sheet: ${laptops.length} laptop`);
    return laptops;
  } catch (err) {
    console.error('Sheet error:', err.message);
    return laptopCache.data;
  }
}

async function getFAQ() {
  const now = Date.now();
  if (faqCache.data.length > 0 && now - faqCache.lastUpdate < CACHE_TTL) {
    return faqCache.data;
  }
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${FAQ_SHEET_NAME}!A1:B100`,
    });
    const rows = res.data.values || [];
    const faq = rows.slice(1).map(row => ({
      keyword: (row[0] || '').toLowerCase(),
      response: row[1] || '',
    })).filter(f => f.keyword && f.response);
    faqCache = { data: faq, lastUpdate: now };
    return faq;
  } catch (err) {
    console.error('FAQ error:', err.message);
    return faqCache.data;
  }
}

// Search laptops
async function searchLaptops(query) {
  const laptops = await getReadyLaptops();
  const q = query.toLowerCase().trim();
  return laptops.filter(l => {
    const all = `${l.model} ${l.cpu} ${l.ram} ${l.ssd}`.toLowerCase();
    return all.includes(q) || l.model.toLowerCase().includes(q);
  });
}

// Search FAQ
async function searchFAQ(query) {
  const faq = await getFAQ();
  const q = query.toLowerCase().trim();
  const match = faq.find(f => q.includes(f.keyword) || f.keyword.includes(q));
  return match ? match.response : null;
}

// Claude AI
let monthlyTokens = 0;
let resetMonth = new Date().getMonth();

async function askClaude(question) {
  if (new Date().getMonth() !== resetMonth) {
    monthlyTokens = 0;
    resetMonth = new Date().getMonth();
  }
  if (monthlyTokens > 2000000) {
    return 'Энэ сарын AI хязгаарт хүрсэн. Загвар нэр бичвэл мэдээлэл өгнө. Жишээ: "7490"';
  }
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const laptops = await getReadyLaptops();
    const list = laptops.slice(0, 15).map(l =>
      `${l.model} (${l.cpu} ${l.gen}th, ${l.ram}GB RAM, ${l.ssd}GB SSD) - ${l.price}₮`
    ).join('\n');

    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      system: `Та лаптоп худалдааны туслах. Монгол хэлээр богино хариулна.
Зарахад бэлэн лаптопууд:
${list}
Дүрэм: Зөвхөн бэлэн лаптоп санал болго. Баталгаа: 6 сар. Төлбөр: Бэлэн, данс, хуваан төлөх.`,
      messages: [{ role: 'user', content: question }],
    });
    monthlyTokens += (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0);
    return res.content[0].text;
  } catch (err) {
    console.error('AI error:', err.message);
    return 'Загвар нэр бичнэ үү (жишээ: "7490", "5400")';
  }
}

// Main handler
async function handleMessage(senderPsid, text) {
  console.log(`MSG ${senderPsid}: ${text}`);
  
  // 1. Sheet search (FREE)
  const results = await searchLaptops(text);
  if (results.length > 0) {
    let reply;
    if (results.length === 1) {
      reply = results[0].botResponse;
    } else if (results.length <= 5) {
      reply = `${results.length} лаптоп олдлоо:\n\n` +
        results.map((l, i) => `${i+1}. ${l.botResponse}`).join('\n\n');
    } else {
      reply = `${results.length} лаптоп олдлоо. Эхний 5:\n\n` +
        results.slice(0, 5).map((l, i) => `${i+1}. ${l.botResponse}`).join('\n\n') +
        '\n\nНарийн хайхыг хүсвэл загварын дугаар бичнэ үү.';
    }
    return sendMessage(senderPsid, reply);
  }

  // 2. FAQ search (FREE)
  const faq = await searchFAQ(text);
  if (faq) return sendMessage(senderPsid, faq);

  // 3. Claude AI (PAID)
  const ai = await askClaude(text);
  return sendMessage(senderPsid, ai);
}

// Send FB message
async function sendMessage(recipientId, text) {
  try {
    await fetch(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${EAAczFRmrK3ABRJxCaXjZByRKZCnpro6QhTfUdeZARwC70IWGnPWmXBdQ8hGW4f7esfRRVZAtVgd0hJLdaTmpmrttfWsfMzuK808tjAIytyu9fLPaj3AB6vg0CkxwGZBLXwFZCegRU2CzZCCvYWp5OlZCEZAVwG5yg7uiuaHMInAC4lnEdVGWZATNYbbdn2ZCBSXhqROJzNwqB6aWdmGzLQj6V1TRab7OG4HIB9vouuxAIOhFtdpWA5SWymL33xWWMefWuEYSYTu7I898ArjYzO6eCPcwCNxjjTSP1lZBgfZBZCntsjQhaTPn3bJkJIiG0jUvgJ0ED2Vs0Qjg6ZAZBfUV}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: text.substring(0, 2000) },
        }),
      }
    );
  } catch (err) {
    console.error('FB error:', err.message);
  }
}

// Webhook verify
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook messages
app.post('/webhook', async (req, res) => {
  if (req.body.object === 'page') {
    for (const entry of req.body.entry) {
      const event = entry.messaging?.[0];
      if (event?.message?.text) {
        await handleMessage(event.sender.id, event.message.text);
      }
    }
    res.status(200).send('OK');
  } else {
    res.sendStatus(404);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'running', laptops: laptopCache.data.length, aiTokens: monthlyTokens });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
  getReadyLaptops();
  getFAQ();
});
