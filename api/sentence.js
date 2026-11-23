// Vercel serverless proxy: tạo câu ví dụ (EN + VI) cho một từ vựng.
// Env: APP_PASSCODE (bắt buộc), GEMINI_API_KEY (mặc định) hoặc ANTHROPIC_API_KEY + PROVIDER=claude
// Tùy chọn: GEMINI_MODEL (mặc định gemini-3.1-flash-lite), CLAUDE_MODEL (mặc định claude-haiku-5-5)
const crypto = require('crypto');
const hits = new Map(); // best-effort rate limit theo instance
const LIMIT = 60, WINDOW = 3600e3;

function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  h.push(now); hits.set(ip, h);
  if (hits.size > 500) for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW)) hits.delete(k);
  return h.length > LIMIT;
}
const CTX = {
  work: 'a workplace situation (office, meetings, emails, business)',
  life: 'an everyday-life situation (shopping, travel, home, friends)',
  mix: 'a common everyday or workplace situation'
};
function prompt(b) {
  const avoid = (b.avoid || []).slice(0, 4).map(s => '- ' + String(s).slice(0, 160)).join('\n');
  return `Write ONE simple English example sentence using the word "${b.word}"${b.pos ? ` (${b.pos})` : ''}${b.meaning ? `, which means "${b.meaning}" in Vietnamese` : ''}.
Setting: ${CTX[b.ctx] || CTX.mix}.
Rules: 8-14 words; CEFR A2-B1 vocabulary besides the target word; natural and realistic; use the target word with that meaning (inflections allowed); no quotes or notes.${avoid ? `\nDo not repeat or closely imitate these:\n${avoid}` : ''}
Also give a natural Vietnamese translation of the sentence.
Reply with JSON only: {"en":"...","vi":"..."}`;
}
function parse(t) {
  t = String(t || '').replace(/```(?:json)?/g, '').trim();
  const m = t.match(/\{[\s\S]*\}/); if (!m) throw new Error('bad');
  const o = JSON.parse(m[0]);
  if (typeof o.en !== 'string' || typeof o.vi !== 'string') throw new Error('bad');
  return { en: o.en.trim(), vi: o.vi.trim() };
}
async function gemini(p, model) {
  const gc = { responseMimeType: 'application/json', maxOutputTokens: 1024, temperature: 1 };
  if (process.env.GEMINI_THINKING) gc.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You are an English teacher writing example sentences for TOEIC learners.' }] },
      contents: [{ role: 'user', parts: [{ text: p }] }],
      generationConfig: gc
    })
  });
  if (!r.ok) { const e = new Error('upstream'); e.status = r.status; e.detail = (await r.text().catch(() => '')).slice(0, 300); throw e; }
  const j = await r.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  return parse(parts.filter(x => !x.thought).map(x => x.text || '').join(''));
}
async function claude(p) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5', max_tokens: 300,
      system: 'You are an English teacher writing example sentences for TOEIC learners.',
      messages: [{ role: 'user', content: p }]
    })
  });
  if (!r.ok) { const e = new Error('upstream'); e.status = r.status; e.detail = (await r.text().catch(() => '')).slice(0, 300); throw e; }
  const j = await r.json();
  return parse((j.content || []).map(x => x.text || '').join(''));
}
const has = (en, w) => {
  const k = String(w).toLowerCase().split(/\s+/)[0].replace(/[^a-z'-]/g, '');
  const stem = k.length > 5 ? k.slice(0, k.length - 2) : k.length > 3 ? k.slice(0, k.length - 1) : k;
  return en.toLowerCase().includes(stem);
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (c, o) => res.status(c).json(o);
  if (req.method !== 'POST') return send(405, { error: 'method' });
  const pass = process.env.APP_PASSCODE;
  if (!pass) return send(500, { error: 'config', msg: 'Server chưa đặt APP_PASSCODE' });
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b) } catch (e) { b = null } }
  if (!b || typeof b !== 'object') return send(400, { error: 'bad' });
  if (!same(b.pass || '', pass)) return send(401, { error: 'pass' });
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || 'x');
  if (limited(ip)) return send(429, { error: 'rate' });
  const word = String(b.word || '').trim();
  if (!word || word.length > 40 || !/^[A-Za-z][A-Za-z '\-./&]*$/.test(word)) return send(400, { error: 'word' });
  const q = {
    word, pos: String(b.pos || '').slice(0, 20), meaning: String(b.meaning || '').slice(0, 80),
    ctx: CTX[b.ctx] ? b.ctx : 'mix', avoid: Array.isArray(b.avoid) ? b.avoid : []
  };
  const useClaude = (process.env.PROVIDER || '').toLowerCase() === 'claude';
  if (!(useClaude ? process.env.ANTHROPIC_API_KEY : process.env.GEMINI_API_KEY)) return send(500, { error: 'config', msg: 'Server chưa có API key' });
  try {
    let out = null, last = null;
    const models = useClaude ? [''] : (process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.6-flash').split(',').map(x => x.trim()).filter(Boolean);
    for (const m of models) { // quá tải / hết lượt / sai tên model: thử model kế tiếp
      for (let i = 0; i < 2 && !out; i++) {
        try { out = await (useClaude ? claude(prompt(q)) : gemini(prompt(q), m)); }
        catch (e) { last = e; if (e.status) break; continue; }
        if (!(has(out.en, word) && out.en.length < 200 && out.vi)) out = null;
      }
      if (out) break;
    }
    if (!out && last) throw last;
    if (!out) return send(502, { error: 'invalid' });
    return send(200, out);
  } catch (e) {
    if (e.status === 429) return send(503, { error: 'quota' });
    return send(502, { error: 'upstream', status: e.status || 0, detail: e.detail || String(e.message || e).slice(0, 200) });
  }
};
