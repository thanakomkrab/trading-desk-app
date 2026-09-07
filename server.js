require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-5';

const CEO_SYSTEM_PROMPT = `คุณคือ "CEO" ของทีมเทรด AI สมมติในหน้าดัชบอร์ดนี้ ทีมของคุณมีลูกทีม 5 คน: นักวิเคราะห์ข่าว, นักคัดกรองคู่เงิน, นักจับจังหวะเข้าซื้อ, ผู้จัดการความเสี่ยง, เจ้าหน้าที่ส่งคำสั่ง
บทบาทของคุณ: คุยกับผู้ใช้ (เจ้านายตัวจริง) แบบมืออาชีพ กระชับ เป็นกันเอง ใช้ภาษาไทย เหมือนหัวหน้าทีมที่คุ้นเคยกัน
คุณคุยได้ตามสามัญสำนึกในทุกเรื่อง ไม่จำเป็นต้องวนกลับมาเรื่องเทรดเสมอไป
หน้านี้มีข้อมูลข่าว/อัตราแลกเปลี่ยน/แนวโน้มจริงที่ทีมดึงมาได้ ถ้าข้อความของผู้ใช้มีบล็อก "ข้อมูลล่าสุดที่ทีมดึงมา" แนบมา ให้ใช้ข้อมูลนั้นเป็นหลักในการตอบ และบอกด้วยว่าดึงมาเมื่อไหร่ ถ้าไม่มีข้อมูลแนบมาและผู้ใช้ถามเรื่องข่าว/ราคาเฉพาะเจาะจง ให้แนะนำให้กดปุ่ม "ดึงข้อมูลล่าสุด" ก่อน อย่าสร้างตัวเลขหรือข่าวขึ้นมาเอง
ตอบให้กระชับพอเหมาะกับคำถาม`;

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON found in model output: ' + text.slice(0, 200));
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callAnthropic({ system, messages, tools }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      system,
      messages,
      ...(tools ? { tools } : {})
    })
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const data = await resp.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function askWithSearchAsJson(system, user, isRetry) {
  const text = await callAnthropic({
    system,
    messages: [{ role: 'user', content: user }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  });
  try {
    return extractJson(text);
  } catch (err) {
    if (isRetry) throw err;
    return askWithSearchAsJson(system, user + '\n\n(สำคัญ: ตอบเป็น JSON ล้วนๆ เท่านั้น ห้ามมีคำอธิบายอื่นนอก JSON)', true);
  }
}

// --- News Analyst: real web search via Claude, run server-side with a real API key ---
app.get('/api/news', async (req, res) => {
  const pair = req.query.pair || 'EUR/USD';
  try {
    const system = `คุณคือ "นักวิเคราะห์ข่าว" ในทีมเทรด ค้นข่าวล่าสุดที่เกี่ยวข้องกับคู่เงินที่ได้รับจากเว็บ สรุปเป็นภาษาไทยด้วยคำพูดของตัวเองเท่านั้น ห้ามคัดลอกประโยคจากแหล่งข่าวโดยตรง
ตอบกลับเป็น JSON เท่านั้น ไม่มีข้อความอื่นนอก JSON รูปแบบ:
{"items":[{"source":"ชื่อแหล่งข่าว","summary":"สรุปสั้นๆ 1 ประโยคภาษาไทย","tone":"positive|negative|neutral"}]}
ให้ 3-4 รายการ ถ้าหาไม่พบให้ส่ง items เป็น array ว่าง`;
    const user = `ค้นข่าวและปัจจัยล่าสุดที่อาจกระทบคู่เงิน ${pair}`;
    const result = await askWithSearchAsJson(system, user);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Pair Screener: real live rate from Twelve Data ---
app.get('/api/rate', async (req, res) => {
  const pair = req.query.pair || 'EUR/USD';
  try {
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(pair)}&apikey=${TWELVE_DATA_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === 'error' || data.code) throw new Error(data.message || 'Twelve Data error');
    res.json({
      rate: parseFloat(data.price),
      change_note: 'ราคาล่าสุดจาก Twelve Data (เกือบเรียลไทม์)',
      source: 'Twelve Data',
      as_of: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Entry Timing: real intraday time series from Twelve Data ---
app.get('/api/trend', async (req, res) => {
  const pair = req.query.pair || 'EUR/USD';
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=1h&outputsize=24&apikey=${TWELVE_DATA_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === 'error') throw new Error(data.message || 'Twelve Data error');
    const points = (data.values || [])
      .slice()
      .reverse()
      .map(v => ({ label: v.datetime.slice(5, 16), value: parseFloat(v.close) }));
    res.json({
      points,
      confidence: 'high',
      note: 'ราคาปิดรายชั่วโมงย้อนหลัง 24 ชั่วโมง จาก Twelve Data',
      source: 'Twelve Data'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CEO chat ---
app.post('/api/chat', async (req, res) => {
  try {
    const messages = req.body.messages || [];
    const text = await callAnthropic({ system: CEO_SYSTEM_PROMPT, messages });
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CEO memo synthesis (top alert banner) ---
app.post('/api/memo', async (req, res) => {
  try {
    const { pair, context } = req.body;
    const system = `คุณคือ "CEO" ของทีมเทรด AI สรุปรายงานจากลูกทีมให้เป็น "บันทึกแจ้งเตือน" สั้นๆ เป็นภาษาไทย สำหรับส่งให้เจ้านาย
ห้ามสร้างข้อมูลใหม่เอง ใช้เฉพาะข้อมูลที่แนบมาเท่านั้น ถ้าข้อมูลไม่ชัดเจนหรือขัดแย้งกันให้บอกตรงๆ อย่าฟันธงเกินกว่าที่ข้อมูลรองรับ
ตอบเป็น JSON เท่านั้น รูปแบบ: {"headline":"หัวข้อสั้นๆ 1 บรรทัด","body":"เนื้อความสรุป 2-4 ประโยค อ้างอิงเฉพาะข้อมูลที่ได้รับ"}`;
    const user = `นี่คือข้อมูลที่ทีมดึงมาได้จริงสำหรับคู่เงิน ${pair}:\n${context}\n\nช่วยสรุปเป็นบันทึกแจ้งเตือนสั้นๆ ให้เจ้านาย`;
    const text = await callAnthropic({ system, messages: [{ role: 'user', content: user }] });
    res.json(extractJson(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Trading desk backend running on http://localhost:${PORT}`));
