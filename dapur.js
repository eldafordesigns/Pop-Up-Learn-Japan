'use strict';
// DAPUR + RUANG MAKAN (100% gratis)
// - Mengambil subtitle YouTube (bahasa apa pun)
// - Memilih kata Jepang acak dengan kuromoji (program gratis di dalam folder ini)
// - Arti Indonesia/Inggris dari Google Translate (jalur tidak resmi, gratis) + cadangan MyMemory
// - Menyajikan halaman aplikasi (index.html)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SUB_LIMIT = 20; // subtitle per menit per pengunjung
const HL_LIMIT = 12;  // sorotan kata per menit per pengunjung
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com']);

const MSG = {
  BAD_LINK: 'Link tidak valid. Tempel link video yang lengkap.',
  UNSUPPORTED_SITE: 'Situs ini belum didukung. Saat ini hanya YouTube.',
  NO_SUBTITLE: 'Video ini tidak punya subtitle. Silakan cari video lain.',
  RATE_LIMIT: 'Terlalu banyak permintaan. Tunggu satu menit lalu coba lagi.',
  UPSTREAM: 'Gagal mengambil subtitle dari YouTube. Coba lagi nanti, pilih video lain, atau tempel subtitle manual.',
  BAD_INPUT: 'Data yang dikirim tidak lengkap atau tidak valid.',
  NO_WORDS: 'Tidak ada kata yang cocok di bagian ini. Tekan NEXT untuk mencoba lagi.',
  TRANSLATE_FAIL: 'Layanan terjemahan sedang sibuk. Tekan NEXT untuk mencoba lagi.',
  NO_TOKENIZER: 'Mesin pemecah kata Jepang belum siap. Tunggu sebentar lalu coba lagi.',
};

// ---------- Subtitle ----------
function extractVideoId(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { error: 'BAD_LINK' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'BAD_LINK' };
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return { error: 'UNSUPPORTED_SITE' };
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  else { const m = u.pathname.match(/^\/(shorts|embed|live)\/([^/?]+)/); if (m) id = m[2]; }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { id } : { error: 'BAD_LINK' };
}

function cleanText(t) {
  return String(t ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function parseJson3(data) {
  const cues = [];
  for (const ev of (data && data.events) || []) {
    if (!ev.segs) continue;
    const text = cleanText(ev.segs.map((s) => s.utf8 || '').join(''));
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    cues.push({ start, end: start + (ev.dDurationMs || 0) / 1000, text });
  }
  return cues;
}

function pickTrack(tracks) { // Jepang > Indonesia > Inggris > lain; buatan manusia dulu
  const match = (t, l) => t.languageCode === l || (t.languageCode || '').startsWith(l + '-');
  for (const l of ['ja', 'id', 'en']) {
    const list = tracks.filter((t) => match(t, l));
    if (list.length) return list.find((t) => t.kind !== 'asr') || list[0];
  }
  return tracks.find((t) => t.kind !== 'asr') || tracks[0] || null;
}

async function getText(fetchImpl, url, opts = {}) {
  const r = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text();
  if (t.length > 3e6) throw new Error('terlalu besar');
  return t;
}

function captionUrl(baseUrl) {
  const u = new URL(baseUrl);
  if (u.protocol !== 'https:' || !(u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com'))) throw new Error('alamat subtitle mencurigakan');
  u.searchParams.set('fmt', 'json3');
  return u.toString();
}

async function fetchSubtitles(fetchImpl, videoId) {
  const info = JSON.parse(await getText(fetchImpl, 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip' },
    body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, hl: 'en' } }, videoId }),
  }));
  const track = pickTrack(info?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []);
  if (!track) return { error: 'NO_SUBTITLE' };
  const cues = parseJson3(JSON.parse(await getText(fetchImpl, captionUrl(track.baseUrl))));
  if (!cues.length) return { error: 'NO_SUBTITLE' };
  return { ok: true, videoId, title: cleanText(info?.videoDetails?.title), language: track.languageCode, auto: track.kind === 'asr', cues };
}

// ---------- Kana & romaji ----------
const toHiragana = (s) => s.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const isKatakanaOnly = (s) => /^[\u30A0-\u30FF]+$/.test(s);
const hasKanji = (s) => /[\u4E00-\u9FFF\u3005]/.test(s);

const KANA = { ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o', カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko', ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go', サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo', タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to', ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do', ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no', ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho', バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo', パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po', マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo', ヤ: 'ya', ユ: 'yu', ヨ: 'yo', ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa', ヲ: 'o', ン: 'n', ヴ: 'vu' };
const SMALL_Y = { ャ: 'a', ュ: 'u', ョ: 'o' };
const SMALL_V = { ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o' };

function toRomaji(input) { // katakana (atau hiragana) -> romaji Hepburn sederhana
  const s = [...input.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))];
  let out = '', dbl = false;
  const push = (syl) => { if (dbl) { syl = (syl.startsWith('ch') ? 't' : syl[0]) + syl; dbl = false; } out += syl; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === 'ッ') { dbl = true; continue; }
    if (c === 'ー') { const v = out.match(/[aiueo](?!.*[aiueo])/); if (v) out += v[0]; continue; }
    let syl = KANA[c];
    if (syl === undefined) { out += /[\u3040-\u30FF]/.test(c) ? '' : c; continue; }
    const next = s[i + 1];
    if (next && SMALL_Y[next] && /[iu]$/.test(syl) && syl !== 'u') {
      syl = ['shi', 'chi', 'ji'].includes(syl) ? syl.slice(0, -1) + SMALL_Y[next] : syl.slice(0, -1) + 'y' + SMALL_Y[next];
      i++;
    } else if (next && SMALL_V[next]) {
      const v = SMALL_V[next];
      if (syl === 'fu') syl = 'f' + v; else if (syl === 'vu') syl = 'v' + v; else if (syl === 'u') syl = 'w' + v;
      else if (['shi', 'chi', 'ji'].includes(syl)) syl = syl.slice(0, -1) + v;
      else if (syl === 'te' || syl === 'de') syl = syl[0] + v;
      else syl = syl.slice(0, -1) + v;
      i++;
    }
    push(syl);
  }
  return out;
}

// ---------- Memilih kata ----------
const CONTENT = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞', '感動詞']);
const SKIP_DETAIL = new Set(['非自立', '接尾', '数', '固有名詞', '特殊', '副詞可能']);

function isContent(t) {
  if (!CONTENT.has(t.pos) || SKIP_DETAIL.has(t.pos_detail_1)) return false;
  const s = t.surface_form;
  if (/^[\u3040-\u309F]$/.test(s)) return false; // satu huruf hiragana: terlalu sepele
  return /[\u3040-\u30FF\u4E00-\u9FFF\u3005]/.test(s) && !!t.reading && t.reading !== '*';
}

function candidates(tokens, n, exclude) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    const w = tokens.slice(i, i + n);
    if (!isContent(w[0]) || !isContent(w[n - 1]) || w.some((t) => t.pos === '記号' || !t.reading)) continue;
    const surface = w.map((t) => t.surface_form).join('');
    if (!exclude.includes(surface)) out.push({ w, surface });
  }
  return out;
}

function partsOf(w) {
  return w.map((t) => {
    const kata = isKatakanaOnly(t.surface_form);
    return { reading: kata ? t.surface_form : toHiragana(t.reading), kanji: hasKanji(t.surface_form) ? t.surface_form : null, romaji: toRomaji(t.reading), is_katakana: kata };
  });
}

// ---------- Terjemahan (gratis) ----------
async function translate(fetchImpl, cache, text, sl, tl) {
  const key = `${sl}|${tl}|${text}`;
  if (cache.has(key)) return cache.get(key);
  let out = '';
  try {
    const u = new URL('https://translate.googleapis.com/translate_a/single');
    u.search = new URLSearchParams({ client: 'gtx', sl, tl, dt: 't', q: text }).toString();
    out = ((JSON.parse(await getText(fetchImpl, u))[0]) || []).map((x) => (x && x[0]) || '').join('').trim();
  } catch { out = ''; }
  if (!out) {
    try {
      const u = new URL('https://api.mymemory.translated.net/get');
      u.search = new URLSearchParams({ q: text, langpair: `${sl}|${tl}` }).toString();
      out = cleanText(JSON.parse(await getText(fetchImpl, u))?.responseData?.translatedText);
    } catch { out = ''; }
  }
  if (!out) throw new Error('terjemahan gagal');
  if (cache.size > 1000) cache.clear();
  cache.set(key, out);
  return out;
}

// ---------- Kartu pop-up (aturan format dijaga kode ini) ----------
function buildCard(ai, wordCount) {
  if (!ai || !Array.isArray(ai.parts) || ai.parts.length !== wordCount) return null;
  const s = (v, n = 80) => cleanText(v).slice(0, n);
  const parts = ai.parts.map((p) => ({ reading: s(p && p.reading, 40), kanji: p && p.kanji ? s(p.kanji, 40) : null, romaji: s(p && p.romaji, 40), isKatakana: !!(p && p.is_katakana === true) }));
  if (parts.some((p) => !p.reading || !p.romaji)) return null;
  const meaningId = s(ai.meaning_id), meaningEn = s(ai.meaning_en);
  if (!meaningId || !meaningEn) return null;
  const rom = s(ai.romaji) || parts.map((p) => p.romaji).join(' ');
  const romaji = rom.charAt(0).toUpperCase() + rom.slice(1);
  const allKatakana = parts.every((p) => p.isKatakana);
  const anyKanji = parts.some((p) => p.kanji);
  const card = {
    type: wordCount === 1 ? 'single' : 'phrase',
    title: `${romaji}: ${meaningId}/${meaningEn}`,
    romaji, meaningId, meaningEn,
    hiragana: allKatakana ? null : parts.map((p) => p.reading).join(''), // kata katakana: hiragana tidak ditulis
    katakana: allKatakana ? parts.map((p) => p.reading).join('') : null,
    kanji: anyKanji ? parts.map((p) => p.kanji || p.reading).join('') : null,
    parts,
  };
  if (wordCount > 1) {
    card.readingWithRomaji = parts.map((p) => `${p.reading} (${p.romaji})`).join(' ');
    card.kanjiWithRomaji = anyKanji ? parts.map((p) => `${p.kanji || p.reading} (${p.romaji})`).join(' ') : null;
  }
  return card;
}

function cleanInput(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 12) return { error: true };
  const lines = b.lines.map((l) => cleanText(l && l.text).slice(0, 200)).filter(Boolean);
  const lang = String(b.sourceLang || '');
  if (!lines.length || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang)) return { error: true };
  const wordCount = Math.min(3, Math.max(1, Math.round(Number(b.wordCount) || 1)));
  const exclude = (Array.isArray(b.exclude) ? b.exclude : []).slice(0, 50).map((x) => cleanText(x).slice(0, 40)).filter(Boolean);
  return { lines, lang, wordCount, exclude };
}

function readBody(req, max = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false; const chunks = [];
    req.on('data', (c) => { if (tooBig) return; size += c.length; if (size > max) { tooBig = true; chunks.length = 0; reject(new Error('besar')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Mesin kuromoji: dimuat sekali, dipakai berulang.
let kuromojiPromise;
function defaultTokenizer() {
  if (!kuromojiPromise) {
    kuromojiPromise = new Promise((resolve, reject) => {
      const kuromoji = require('kuromoji');
      const dicPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
      kuromoji.builder({ dicPath }).build((err, tk) => (err ? reject(err) : resolve(tk)));
    });
    kuromojiPromise.catch(() => { kuromojiPromise = null; });
  }
  return kuromojiPromise.then((tk) => (text) => tk.tokenize(text));
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; img-src 'self' data: https://i.ytimg.com; media-src *; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

function createServer({ fetchImpl = fetch, getTokenizer = defaultTokenizer, indexPath = path.join(__dirname, 'index.html') } = {}) {
  const hits = new Map();
  const cache = new Map();
  setInterval(() => hits.clear(), 60000).unref();

  return http.createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const fail = (status, code) => send(status, { ok: false, code, message: MSG[code] });
    try {
      const url = new URL(req.url, 'http://localhost');
      const ip = (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress;
      const tooMany = (bucket, max) => { const k = bucket + ':' + ip; const n = (hits.get(k) || 0) + 1; hits.set(k, n); return n > max; };

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        let html; try { html = fs.readFileSync(indexPath); } catch { return send(404, { ok: false, message: 'Halaman belum ada.' }); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true });

      if (req.method === 'GET' && url.pathname === '/api/subtitles') {
        if (tooMany('sub', SUB_LIMIT)) return fail(429, 'RATE_LIMIT');
        const raw = url.searchParams.get('url') || '';
        const v = raw.length > 300 ? { error: 'BAD_LINK' } : extractVideoId(raw);
        if (v.error) return fail(400, v.error);
        let out;
        try { out = await fetchSubtitles(fetchImpl, v.id); } catch { return fail(502, 'UPSTREAM'); }
        return out.error ? send(200, { ok: false, code: out.error, message: MSG[out.error] }) : send(200, out);
      }

      if (req.method === 'POST' && url.pathname === '/api/highlight') {
        if (tooMany('hl', HL_LIMIT)) return fail(429, 'RATE_LIMIT');
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(415, { ok: false, code: 'BAD_INPUT', message: MSG.BAD_INPUT });
        let raw;
        try { raw = await readBody(req); } catch { res.setHeader('Connection', 'close'); return send(413, { ok: false, code: 'BAD_INPUT', message: MSG.BAD_INPUT }); }
        let body; try { body = JSON.parse(raw); } catch { return fail(400, 'BAD_INPUT'); }
        const inp = cleanInput(body);
        if (inp.error) return fail(400, 'BAD_INPUT');

        let tokenize; try { tokenize = await getTokenizer(); } catch { return fail(503, 'NO_TOKENIZER'); }
        let japanese = inp.lines.join('\n'), viaTranslation = false;
        if (inp.lang !== 'ja' && !inp.lang.startsWith('ja-')) { // bukan Jepang: terjemahkan dulu ke Jepang
          try { japanese = await translate(fetchImpl, cache, japanese, inp.lang.split('-')[0], 'ja'); viaTranslation = true; } catch { return fail(502, 'TRANSLATE_FAIL'); }
        }
        const pool = candidates(tokenize(japanese), inp.wordCount, inp.exclude);
        if (!pool.length) return fail(200, 'NO_WORDS');
        const pick = pool[Math.floor(Math.random() * pool.length)];
        let id, en;
        try { [id, en] = await Promise.all([translate(fetchImpl, cache, pick.surface, 'ja', 'id'), translate(fetchImpl, cache, pick.surface, 'ja', 'en')]); } catch { return fail(502, 'TRANSLATE_FAIL'); }
        const parts = partsOf(pick.w);
        const card = buildCard({ romaji: parts.map((p) => p.romaji).join(' '), meaning_id: id, meaning_en: en, parts }, inp.wordCount);
        return card ? send(200, { ok: true, card, surface: pick.surface, viaTranslation }) : fail(502, 'NO_WORDS');
      }

      return send(['GET', 'POST'].includes(req.method) ? 404 : 405, { ok: false, message: 'Tidak ditemukan.' });
    } catch {
      return send(500, { ok: false, message: 'Terjadi kesalahan di dapur.' });
    }
  });
}

module.exports = { createServer, extractVideoId, parseJson3, pickTrack, captionUrl, cleanText, buildCard, cleanInput, toRomaji, toHiragana, candidates, partsOf };

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log('Aplikasi menyala di http://localhost:' + PORT);
    defaultTokenizer().then(() => console.log('Mesin kata Jepang siap.'), (e) => console.log('PERINGATAN: kuromoji belum terpasang. Jalankan: npm install  (' + e.message + ')'));
  });
}
