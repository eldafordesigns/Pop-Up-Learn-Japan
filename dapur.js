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
const HL_MAX_LINES = 3000;   // semua cue dalam satu interval (interval maksimum 60 menit) boleh dikirim
const HL_MAX_CHARS = 60000;  // total huruf yang dianalisis per permintaan; di atas ini cue dipilih merata dari seluruh interval
const HL_BODY_MAX = 700000;  // batas ukuran badan permintaan /api/highlight (byte)
const TR_ENC_MAX = 3500;     // panjang maksimum satu potongan teks (setelah di-encode URL) untuk layanan terjemahan GET
const HL_BATCH = 3;          // jumlah kandidat yang diterjemahkan serentak dalam satu putaran (subtitle non-Jepang)
const HL_ROUNDS = 3;         // putaran maksimum per permintaan; kandidat yang tidak bisa diverifikasi dilewati lalu dicatat
const TR_MAX_CHUNKS = 6;     // jumlah potongan terjemahan maksimum per sorotan; bila lebih, potongan dipilih merata
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com']);

const MSG = {
  BAD_LINK: 'Invalid link. Paste the full video link.',
  UNSUPPORTED_SITE: 'This site is not supported yet. Only YouTube is supported at the moment.',
  NO_SUBTITLE: 'Subtitles are not detected',
  RATE_LIMIT: 'Too many requests. Wait one minute and try again.',
  UPSTREAM: 'Failed to retrieve subtitles from YouTube. Try again later, choose another video, or paste the subtitles manually.',
  BAD_INPUT: 'The data sent is incomplete or invalid.',
  NO_WORDS: 'No matching words found in this section. Press PLAY AGAIN to continue the video.',
  NO_MORE_WORDS: 'You have seen all the words in this section. Press PLAY AGAIN to continue the video.',
  NOT_VERIFIED: 'No Japanese equivalent could be verified for the words tried this time. Press NEXT to try other words.',
  TRANSLATE_FAIL: 'The translation service is busy. Press NEXT to try again.',
  BOT_BLOCK: 'YouTube refused to provide subtitles to this server (the server was treated as a bot). Use "Paste manually" below: upload or paste a .srt/.vtt subtitle file.',
  QUOTA: 'This month\'s subtitle service quota has been used up. Use "Paste manually" below, or try again next month.',
  NO_TOKENIZER: 'The Japanese word-splitting engine is not ready yet. Wait a moment and try again.',
  IS_YOUTUBE: 'YouTube links use the YouTube subtitle route, not the source-page route.',
  PAGE_BLOCKED: 'The source site refused the automated request (login, verification, or another restriction is required). The app does not try to bypass it. Use "Paste manually" below.',
  PAGE_FAIL: 'The server could not open the video source page. Check the link, or use "Paste manually" below.',
  NO_TRACKS: 'No public subtitles could be read from this page. On many sites the subtitles are loaded by the player through JavaScript or use tokens, so they cannot be retrieved automatically. Use "Paste manually" below.',
  TRACK_FAIL: 'Subtitles were found, but the file could not be downloaded or read (unsupported or protected format). Use "Paste manually" below.',
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

const matchLang = (t, l) => t.languageCode === l || (t.languageCode || '').startsWith(l + '-');
function orderTracks(tracks) { // Jepang > Indonesia > Inggris > lain; buatan manusia dulu, lalu otomatis
  const out = [], seen = new Set();
  const add = (list) => { for (const t of [...list.filter((x) => x.kind !== 'asr'), ...list.filter((x) => x.kind === 'asr')]) if (!seen.has(t)) { seen.add(t); out.push(t); } };
  for (const l of ['ja', 'id', 'en']) add(tracks.filter((t) => matchLang(t, l)));
  add(tracks);
  return out;
}
const pickTrack = (tracks) => orderTracks(tracks)[0] || null;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

async function getText(fetchImpl, url, opts = {}, lim = {}) {
  const r = await fetchImpl(url, { redirect: 'error', ...opts, signal: AbortSignal.timeout(lim.timeout || 8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text();
  if (t.length > (lim.max || 3e6)) throw new Error('terlalu besar');
  return t;
}

function captionUrl(baseUrl, fmt = 'json3') {
  const u = new URL(baseUrl);
  if (u.protocol !== 'https:' || !(u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com'))) throw new Error('alamat subtitle mencurigakan');
  if (fmt) u.searchParams.set('fmt', fmt); else u.searchParams.delete('fmt');
  return u.toString();
}

// ---- pembaca berbagai format subtitle ----
function decodeEntities(s) {
  const once = (x) => x.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l[0] === '#') { const cp = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10); try { return String.fromCodePoint(cp); } catch { return ' '; } }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[l];
  });
  return once(once(String(s)));
}
const attr = (a, n) => { const m = a.match(new RegExp('(?:^|\\s)' + n + '="([^"]*)"')); return m ? m[1] : null; };
const num = (v, k = 1) => (v == null || v === '' ? NaN : Number(v) / k);

function parseXml(xml) { // format srv3 (<p t= d=>) dan format lama (<text start= dur=>)
  const cues = [];
  const add = (start, dur, inner) => {
    const text = cleanText(decodeEntities(inner.replace(/<[^>]*>/g, '')));
    if (text && Number.isFinite(start)) cues.push({ start, end: start + (Number.isFinite(dur) ? dur : 2), text });
  };
  let m;
  const p = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  while ((m = p.exec(xml))) add(num(attr(m[1], 't'), 1000), num(attr(m[1], 'd'), 1000), m[2]);
  if (!cues.length) { const t = /<text\b([^>]*)>([\s\S]*?)<\/text>/g; while ((m = t.exec(xml))) add(num(attr(m[1], 'start')), num(attr(m[1], 'dur')), m[2]); }
  return cues.sort((x, y) => x.start - y.start);
}

function parseTimestamp(s) { const m = String(s).trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/); return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number('0.' + m[4]) : NaN; }
function parseVtt(txt) { // WEBVTT atau SRT
  const cues = [];
  for (const b of String(txt).replace(/\r/g, '').split(/\n{2,}/)) {
    const l = b.split('\n'), i = l.findIndex((x) => x.includes('-->')); if (i < 0) continue;
    const [a, c] = l[i].split('-->'), s = parseTimestamp(a), e = parseTimestamp(String(c || '').trim().split(/\s/)[0]);
    const text = cleanText(decodeEntities(l.slice(i + 1).join(' ').replace(/<[^>]*>/g, '')));
    if (!text || isNaN(s)) continue;
    if (cues.length && cues[cues.length - 1].text === text) { cues[cues.length - 1].end = isNaN(e) ? s + 2 : e; continue; } // baris berulang
    cues.push({ start: s, end: isNaN(e) ? s + 2 : e, text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function parseCaption(raw) { // otomatis mengenali JSON, VTT/SRT, atau XML
  const t = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!t) return [];
  if (t[0] === '{') { try { return parseJson3(JSON.parse(t)); } catch { return []; } }
  if (t.includes('-->')) return parseVtt(t);
  if (t[0] === '<') return parseXml(t);
  return [];
}

function extractPlayerResponse(html) { // ambil data video dari halaman tonton YouTube
  const m = /ytInitialPlayerResponse\s*=\s*\{/.exec(html || ''); if (!m) return null;
  const start = m.index + m[0].length - 1; let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

// ---- beberapa "pintu" ke YouTube; semua dicoba bersamaan, yang berhasil dipakai ----
const YT_CLIENTS = [
  { label: 'ANDROID', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11', hl: 'en' } },
  { label: 'IOS', ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)', client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en' } },
  { label: 'TV', ua: CHROME_UA, embed: true, client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'en' } },
  { label: 'WEB', ua: CHROME_UA, client: { clientName: 'WEB', clientVersion: '2.20250219.01.00', hl: 'en' } },
];
async function playerCall(fetchImpl, c, videoId, ms) {
  const context = { client: c.client }; if (c.embed) context.thirdParty = { embedUrl: 'https://www.google.com/' };
  return JSON.parse(await getText(fetchImpl, 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua, 'Accept-Language': 'en-US,en;q=0.9', Origin: 'https://www.youtube.com' },
    body: JSON.stringify({ context, videoId, contentCheckOk: true, racyCheckOk: true }),
  }, { timeout: ms }));
}
async function pageCall(fetchImpl, videoId, ms) {
  const html = await getText(fetchImpl, `https://www.youtube.com/watch?v=${videoId}&hl=en&has_verified=1&bpctr=9999999999`, {
    redirect: 'follow',
    headers: { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+cb.20240101-00-p0.en+FX+000; SOCS=CAI' },
  }, { timeout: ms, max: 8e6 });
  return extractPlayerResponse(html);
}
const tag = (e) => { const m = /^HTTP (\d+)/.exec((e && e.message) || ''); return m ? m[1] : (e && e.name === 'TimeoutError') ? 'timeout' : 'gagal'; };

async function fetchSubtitles(fetchImpl, videoId, budget = 8000) {
  const deadline = Date.now() + budget, trace = [], ms = Math.min(4500, budget);
  const left = () => Math.max(1000, Math.min(4000, deadline - Date.now()));
  const calls = [...YT_CLIENTS.map((c) => ({ label: c.label, run: () => playerCall(fetchImpl, c, videoId, ms) })), { label: 'PAGE', run: () => pageCall(fetchImpl, videoId, ms) }];
  const results = await Promise.all(calls.map(async (c) => { try { const info = await c.run(); return { label: c.label, info, note: info ? 'ok' : 'kosong' }; } catch (e) { return { label: c.label, info: null, note: tag(e) }; } }));
  results.forEach((r) => trace.push(r.label + ':' + r.note));
  const got = results.filter((r) => r.info && typeof r.info === 'object');
  if (!got.length) return { error: 'UPSTREAM', trace };

  const title = cleanText(got.map((r) => r.info.videoDetails && r.info.videoDetails.title).find(Boolean));
  const sources = got.map((r) => ({ label: r.label, tracks: r.info?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [] })).filter((s) => s.tracks.length);
  if (!sources.length) {
    const okPlay = got.some((r) => r.info.playabilityStatus && r.info.playabilityStatus.status === 'OK');
    const bot = got.some((r) => r.info.playabilityStatus && r.info.playabilityStatus.status === 'LOGIN_REQUIRED' && /bot|sign in/i.test(String(r.info.playabilityStatus.reason || '')));
    return { error: bot && !okPlay ? 'BOT_BLOCK' : 'NO_SUBTITLE', trace };
  }

  const key = (t) => (t.languageCode || '') + '|' + (t.kind || '');
  outer: for (const t of orderTracks(sources[0].tracks).slice(0, 3)) {
    for (const s of sources) {
      const tt = s.tracks.find((x) => key(x) === key(t)); if (!tt || !tt.baseUrl) continue;
      for (const fmt of ['json3', null, 'vtt']) {
        if (Date.now() > deadline) break outer;
        const lbl = `${s.label}/${t.languageCode}/${fmt || 'xml'}`;
        try {
          const cues = parseCaption(await getText(fetchImpl, captionUrl(tt.baseUrl, fmt), { headers: { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9' } }, { timeout: left() }));
          if (cues.length) return { ok: true, videoId, title, language: t.languageCode, auto: t.kind === 'asr', cues };
          trace.push(lbl + ':kosong');
        } catch (e) { trace.push(lbl + ':' + tag(e)); }
      }
    }
  }
  return { error: 'BOT_BLOCK', trace };
}


// ---- Layanan perantara gratis (Supadata): dipakai bila SUPADATA_API_KEY diisi di Vercel ----
async function supadataCall(fetchImpl, key, videoId, lang) {
  const u = new URL('https://api.supadata.ai/v1/transcript');
  u.searchParams.set('url', 'https://www.youtube.com/watch?v=' + videoId); u.searchParams.set('text', 'false'); u.searchParams.set('mode', 'native');
  if (lang) u.searchParams.set('lang', lang);
  const r = await fetchImpl(u.toString(), { headers: { 'x-api-key': key }, redirect: 'error', signal: AbortSignal.timeout(6000) });
  let j = null; try { j = JSON.parse(await r.text()); } catch { /* bukan JSON */ }
  return { status: r.status, j };
}
const supCues = (content) => (Array.isArray(content) ? content : []).map((c) => {
  const start = (Number(c && c.offset) || 0) / 1000, d = (Number(c && c.duration) || 0) / 1000;
  return { start, end: start + (d > 0 ? d : 2), text: cleanText(c && c.text) };
}).filter((c) => c.text);

async function fetchViaSupadata(fetchImpl, key, videoId) { // hasil: {ok,...} | {error:'NO_SUBTITLE'|'QUOTA'|'SOFT', trace}
  const trace = [];
  try {
    const a = await supadataCall(fetchImpl, key, videoId, null); trace.push('SUPADATA:' + a.status);
    if (a.status === 402 || a.status === 429) return { error: 'QUOTA', trace };
    if (a.status === 206 || a.status === 404) return { error: 'NO_SUBTITLE', trace };
    if (a.status !== 200 || !a.j) return { error: 'SOFT', trace };
    let { lang, content } = a.j; const avail = Array.isArray(a.j.availableLangs) ? a.j.availableLangs : [];
    let cues = supCues(content);
    const want = ['ja', 'id', 'en'].find((l) => avail.some((x) => String(x).split('-')[0] === l));
    if (want && String(lang || '').split('-')[0] !== want) { // ada bahasa yang lebih cocok: minta sekali lagi
      try {
        const b = await supadataCall(fetchImpl, key, videoId, want); trace.push('SUPADATA/' + want + ':' + b.status);
        const c2 = b.status === 200 && b.j ? supCues(b.j.content) : [];
        if (c2.length) { cues = c2; lang = b.j.lang || want; }
      } catch { trace.push('SUPADATA/' + want + ':gagal'); }
    }
    if (!cues.length) return { error: 'NO_SUBTITLE', trace };
    return { ok: true, videoId, title: '', language: String(lang || 'und'), auto: false, cues, trace };
  } catch (e) { trace.push('SUPADATA:' + tag(e)); return { error: 'SOFT', trace }; }
}

// ---------- Subtitle dari halaman sumber video lain (bukan YouTube) ----------
// Hanya membaca yang tersedia SECARA PUBLIK: tag <track>, konfigurasi pemutar yang tertulis di HTML/skrip,
// dan halaman pemutar di dalam <iframe> (maksimal 2 tingkat). Subtitle selalu diambil dari rantai halaman/pemutar
// milik URL yang dimasukkan pengguna, jadi terhubung dengan episode yang sedang diputar (bukan dicari lewat judul).
// TIDAK menjalankan JavaScript situs, TIDAK memecahkan token/enkripsi/CAPTCHA/login/DRM. Bila situs menolak, berhenti dan melapor.
const net = require('net');
const dns = require('dns').promises;
const PAGE_LIMIT = 10;         // pencarian subtitle halaman per menit per pengunjung
const PAGE_MAX_PAGES = 6;      // paling banyak halaman (utama + iframe) yang dibuka per permintaan
const PAGE_MAX_DEPTH = 2;      // halaman utama -> iframe -> iframe di dalam iframe

// Server tidak boleh disuruh membuka alamat internal (SSRF): semua alamat dicek ke IP publik, termasuk tiap pengalihan.
function isPrivateIp(ip) {
  ip = String(ip).toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    const m4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m4) return isPrivateIp(m4[1]);
    const mh = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mh) { const hi = parseInt(mh[1], 16), lo = parseInt(mh[2], 16); return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    const h = parseInt(ip.split(':')[0] || '0', 16);
    return (h & 0xfe00) === 0xfc00 || (h & 0xffc0) === 0xfe80 || (h & 0xff00) === 0xff00;
  }
  return true;
}
const defaultLookup = (host) => dns.lookup(host, { all: true });

async function assertPublicUrl(raw, lookup) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protokol');
  if (u.username || u.password) throw new Error('kredensial');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('port');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) throw new Error('alamat lokal');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host);
  if (!addrs || !addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('alamat lokal');
  return u;
}

async function readCapped(r, max) {
  const reader = r.body && r.body.getReader ? r.body.getReader() : null;
  if (!reader) { const t = await r.text(); if (t.length > max) throw new Error('terlalu besar'); return t; }
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch { /* abaikan */ } throw new Error('terlalu besar'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function safeGet(fetchImpl, raw, { lookup, headers = {}, timeout = 4500, max = 3e6 } = {}) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(url, lookup);
    const r = await fetchImpl(u.href, { redirect: 'manual', headers, signal: AbortSignal.timeout(timeout) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).href; continue; }
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return { text: await readCapped(r, max), url: u.href, status: r.status };
  }
  throw new Error('terlalu banyak pengalihan');
}

// ---- membaca daftar subtitle dari HTML / skrip pemutar ----
const attrX = (a, n) => { const m = String(a).match(new RegExp('(?:^|[\\s"\'])' + n + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i')); return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null; };
const LANG_WORDS = { ja: ['ja', 'jpn', 'jp', 'japanese', 'japan', 'nihongo'], en: ['en', 'eng', 'english', 'inggris'], id: ['id', 'ind', 'indo', 'indonesia', 'indonesian', 'bahasa'] };
function langOf(text) { // 'English' / 'ja-JP' / '日本語' / 'eng' -> 'en' | 'ja' | 'id' | null
  const s = String(text || '');
  if (/日本語|日本/.test(s)) return 'ja';
  const toks = s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const l of ['ja', 'en', 'id']) if (toks.some((t) => LANG_WORDS[l].includes(t))) return l;
  return null;
}
const baseName = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop() || '').replace(/\.[a-z0-9]{2,4}$/i, ''); } catch { return ''; } };

function scanTracks(rawText, base) { // -> [{url,label,lang,default}]
  const text = String(rawText || '').replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
  const out = new Map(), skip = new Set(); // skip: file yang sudah diketahui BUKAN subtitle, jangan dimasukkan lagi lewat pemindaian URL
  const add = (src, meta = {}) => {
    if (!src) return;
    let u; try { u = new URL(decodeEntities(src).trim(), base); } catch { return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    if (skip.has(u.href)) return;
    if (/^(metadata|chapters|descriptions|thumbnails)$/i.test(meta.kind || '')) { skip.add(u.href); return; }
    const bn = baseName(u.href);
    if (/thumb|sprite|storyboard/i.test(bn)) return; // file VTT peta gambar, bukan subtitle
    const rawLang = String(meta.srclang || '').split('-')[0].toLowerCase();
    const lang = langOf(meta.srclang) || langOf(meta.label) || langOf(bn) || (/^[a-z]{2,3}$/.test(rawLang) ? rawLang : null);
    const prev = out.get(u.href);
    if (prev) { prev.label = prev.label || meta.label || ''; prev.lang = prev.lang || lang; prev.default = prev.default || !!meta.def; }
    else out.set(u.href, { url: u.href, label: String(meta.label || '').slice(0, 60), lang, default: !!meta.def });
  };
  let m;
  const trackRe = /<track\b[^>]*>/gi; // 1) elemen HTML <track>
  while ((m = trackRe.exec(text))) {
    const kind = (attrX(m[0], 'kind') || 'subtitles').toLowerCase();
    if (kind !== 'subtitles' && kind !== 'captions') { add(attrX(m[0], 'src'), { kind }); continue; }
    add(attrX(m[0], 'src'), { kind, srclang: attrX(m[0], 'srclang'), label: attrX(m[0], 'label'), def: /\sdefault(\s|=|>|\/)/i.test(m[0]) });
  }
  const kv = (chunk, keys) => { const r = chunk.match(new RegExp('["\']?\\b(?:' + keys + ')["\']?\\s*:\\s*["\']([^"\']*)["\']', 'i')); return r ? r[1] : null; };
  const objRe = /\{[^{}]{0,700}?\.(?:vtt|srt)\b[^{}]{0,700}?\}/gi; // 2-3) objek konfigurasi pemutar: {file:"x.vtt", label:"English", kind:"captions"}
  while ((m = objRe.exec(text))) {
    const c = m[0];
    add(kv(c, 'file|url|src|link|path'), { kind: kv(c, 'kind'), srclang: kv(c, 'srclang|lang|language|code'), label: kv(c, 'label|name|title'), def: /["']?default["']?\s*:\s*true/i.test(c) });
  }
  const bare = /https?:\/\/[^\s"'<>\\)]+?\.(?:vtt|srt)(?:\?[^\s"'<>\\)]*)?/gi; // 4) alamat file subtitle yang tertulis langsung
  while ((m = bare.exec(text))) add(m[0]);
  const rel = /["'(]((?:\/|\.\.?\/)[^"'\s<>()]+?\.(?:vtt|srt)(?:\?[^"'\s<>()]*)?)["')]/gi;
  while ((m = rel.exec(text))) add(m[1]);
  return [...out.values()];
}

function scanFrames(text, base) { // 5) pemutar pihak ketiga biasanya ada di <iframe>
  const out = []; let m; const re = /<iframe\b[^>]*>/gi;
  while ((m = re.exec(String(text || '')))) {
    const src = attrX(m[0], 'src') || attrX(m[0], 'data-src') || attrX(m[0], 'data-lazy-src');
    if (!src || /^\s*(about:|javascript:|data:|blob:)/i.test(src)) continue;
    try { const u = new URL(src.trim(), base); if (u.protocol === 'https:' || u.protocol === 'http:') out.push(u.href); } catch { /* abaikan */ }
  }
  return out;
}

function rankCandidates(list, pref) { // 7) bahasa pilihan pengguna dulu, lalu Jepang, Inggris, Indonesia, bahasa lain, tak dikenal
  const order = [pref, 'ja', 'en', 'id'].filter((x, i, a) => x && a.indexOf(x) === i);
  const score = (c) => {
    let s = order.indexOf(c.lang); if (s < 0) s = c.lang ? order.length : order.length + 1;
    if (/forced|sign|song|commentary|karaoke/i.test(c.label || '')) s += 0.5;
    return c.default ? s - 0.1 : s;
  };
  return [...list].sort((a, b) => score(a) - score(b));
}

function guessLang(cues) { // dipakai hanya bila situs tidak menyebut bahasa subtitle
  const t = cues.slice(0, 200).map((c) => c.text).join(' ');
  if (!t) return null;
  const kana = (t.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
  if (kana / t.length > 0.15) return 'ja';
  return (t.match(/[A-Za-z]/g) || []).length / t.length > 0.5 ? 'en' : null;
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '?'; } };
const looksBlocked = (t) => /just a moment|cf-chl|attention required|captcha|ddos-guard|access denied/i.test(String(t || '').slice(0, 4000));

async function fetchPageSubtitles(fetchImpl, pageUrl, { lookup = defaultLookup, pref = 'ja', budget = 8000 } = {}) {
  const deadline = Date.now() + budget, trace = [];
  const left = () => Math.max(800, Math.min(4500, deadline - Date.now()));
  const get = (url, referer) => safeGet(fetchImpl, url, { lookup, timeout: left(), headers: { 'User-Agent': CHROME_UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: '*/*', ...(referer ? { Referer: referer } : {}) } });
  const cands = new Map(), seen = new Set([pageUrl]);
  let title = '', blocked = false, mainFailed = null, fetched = 0, level = [{ url: pageUrl, referer: null }];
  for (let depth = 0; depth <= PAGE_MAX_DEPTH && level.length && Date.now() < deadline; depth++) {
    level = level.slice(0, PAGE_MAX_PAGES - fetched); fetched += level.length;
    const res = await Promise.all(level.map(async (p) => { try { return { p, r: await get(p.url, p.referer) }; } catch (e) { return { p, e }; } }));
    const next = [];
    for (const { p, r, e } of res) {
      const lbl = (depth ? 'FRAME:' : 'PAGE:') + hostOf(p.url);
      if (e) {
        trace.push(lbl + ':' + tag(e));
        if (e.status === 401 || e.status === 403 || e.status === 429 || e.status === 503) blocked = true;
        if (!depth) mainFailed = e;
        continue;
      }
      trace.push(lbl + ':ok');
      if (!depth) title = cleanText(decodeEntities((r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')).slice(0, 120);
      for (const c of scanTracks(r.text, r.url)) { if (!cands.has(c.url)) cands.set(c.url, { ...c, ref: r.url }); }
      if (!cands.size && looksBlocked(r.text)) blocked = true;
      if (depth < PAGE_MAX_DEPTH) for (const f of scanFrames(r.text, r.url)) if (!seen.has(f)) { seen.add(f); next.push({ url: f, referer: r.url }); }
    }
    level = next;
  }
  if (mainFailed && !cands.size) return { error: blocked ? 'PAGE_BLOCKED' : 'PAGE_FAIL', trace };
  if (!cands.size) return { error: blocked ? 'PAGE_BLOCKED' : 'NO_TRACKS', trace };

  const ranked = rankCandidates([...cands.values()], pref);
  const available = ranked.map((c) => ({ lang: c.lang || 'und', label: c.label })).slice(0, 12);
  trace.push('TRACKS:' + ranked.length);
  let denied = false;
  for (const c of ranked.slice(0, 4)) {
    if (Date.now() > deadline) break;
    try {
      const cues = parseCaption((await get(c.url, c.ref)).text);
      if (cues.length) return { ok: true, videoId: null, title, language: c.lang || guessLang(cues) || 'und', label: c.label, auto: false, cues, available, source: hostOf(c.ref || pageUrl), trace };
      trace.push('SUB:' + hostOf(c.url) + ':kosong');
    } catch (e) { trace.push('SUB:' + hostOf(c.url) + ':' + tag(e)); if (e.status === 401 || e.status === 403) denied = true; }
  }
  return { error: denied ? 'PAGE_BLOCKED' : 'TRACK_FAIL', trace };
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

const KANJI_CH = /[\u4E00-\u9FFF\u3005]/;
function kanjiHints(surface, tokenize) { // bacaan hiragana tiap huruf kanji (diambil dari kuromoji), urut sesuai tulisan
  const out = [];
  for (const ch of [...String(surface || '')]) {
    if (!KANJI_CH.test(ch)) continue;
    if (ch === '\u3005') { out.push(out.length ? out[out.length - 1] : ''); continue; }
    let h = '';
    try { const t = tokenize(ch) || []; if (t.length === 1 && t[0].reading && t[0].reading !== '*') h = toHiragana(t[0].reading); } catch { h = ''; }
    out.push(h);
  }
  return out;
}

function partsOf(w, tokenize) {
  return w.map((t) => {
    const kata = isKatakanaOnly(t.surface_form);
    return {
      reading: kata ? t.surface_form : toHiragana(t.reading),
      kanji: hasKanji(t.surface_form) ? t.surface_form : null,
      romaji: toRomaji(t.reading),
      is_katakana: kata,
      hints: tokenize && hasKanji(t.surface_form) ? kanjiHints(t.surface_form, tokenize) : [],
    };
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
  const parts = ai.parts.map((p) => ({
    reading: s(p && p.reading, 40), kanji: p && p.kanji ? s(p.kanji, 40) : null, romaji: s(p && p.romaji, 40), isKatakana: !!(p && p.is_katakana === true),
    hints: Array.isArray(p && p.hints) ? p.hints.slice(0, 20).map((h) => { const x = s(h, 12); return /^[\u3041-\u3096]+$/.test(x) ? x : ''; }) : [],
  }));
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

// Bila total huruf melebihi batas, ambil baris secara merata dari awal sampai akhir interval (urutan tetap), bukan hanya awal/akhir.
function sampleEvenly(lines, maxChars) {
  const total = lines.reduce((a, l) => a + l.length, 0);
  if (total <= maxChars) return lines;
  const k = Math.max(1, Math.floor(lines.length * maxChars / total));
  return Array.from({ length: k }, (_, i) => lines[Math.floor(i * lines.length / k)]);
}

function cleanInput(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > HL_MAX_LINES) return { error: true };
  const lines = sampleEvenly(b.lines.map((l) => cleanText(l && l.text)).filter(Boolean), HL_MAX_CHARS); // cleanText membatasi tiap baris 500 huruf
  const lang = String(b.sourceLang || '');
  if (!lines.length || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang)) return { error: true };
  const wordCount = Math.min(3, Math.max(1, Math.round(Number(b.wordCount) || 1)));
  const exclude = (Array.isArray(b.exclude) ? b.exclude : []).slice(0, 400).map((x) => cleanText(x).slice(0, 80)).filter(Boolean); // riwayat SATU interval (dikelola klien per interval)
  return { lines, lang, wordCount, exclude };
}

// ---------- Memilih kata dari SELURUH teks interval ----------
// 1) teks dipecah per kalimat/baris (kata gabungan tidak boleh melintasi batas kalimat),
// 2) tiap kalimat dipecah kata dengan kuromoji (bukan pemisahan spasi),
// 3) kalimat dipilih acak lebih dulu, baru kata di dalamnya: hasil tersebar di seluruh interval, bukan hanya awal/akhir.
const SENTENCE_BREAK = /[\n。！？!?]+/;
function splitSegments(text) { return String(text).split(SENTENCE_BREAK).map((x) => x.trim()).filter(Boolean); }

function segmentPools(tokenize, segments, n) {
  const pools = [];
  for (const seg of segments) {
    let tokens; try { tokens = tokenize(seg) || []; } catch { continue; }
    const pool = candidates(tokens, n, []).filter((c) => partsOf(c.w).every((p) => p.reading && p.romaji)); // kartu harus bisa dibentuk
    if (pool.length) pools.push(pool);
  }
  return pools;
}

// Kunci pembanding: huruf besar/kecil, tanda baca, apostrof, lebar huruf (NFKC), dan (bahasa Inggris) bentuk jamak diseragamkan,
// sehingga "Things", "things," dan "thing" dianggap kata yang sama.
function foldKey(s, lang = '') {
  const en = String(lang).split('-')[0].toLowerCase() === 'en';
  return (String(s).normalize('NFKC').toLowerCase().replace(/['\u2019\u2018`\u00b4]/g, '').match(/[\p{L}\p{M}\p{N}]+/gu) || [])
    .map((w) => (en && w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

// Kata yang sudah tampil TIDAK dipakai ulang. Bila semua kandidat sudah tampil, hasilnya null (pemanggil menampilkan pesan "sudah habis").
function pickFromPools(pools, exclude = [], rand = Math.random) {
  const skip = new Set(exclude.map((x) => foldKey(x, 'ja')));
  const fresh = pools.map((p) => p.filter((c) => !skip.has(foldKey(c.surface, 'ja')))).filter((p) => p.length);
  if (!fresh.length) return null;
  const seg = fresh[Math.floor(rand() * fresh.length)];
  return seg[Math.floor(rand() * seg.length)];
}

// ---------- Kandidat dari teks sumber (subtitle bukan Jepang) ----------
// Semua kata/frasa diambil dari SELURUH subtitle interval, tanpa bergantung pada kamus: padanan Jepangnya dicari belakangan lewat
// layanan terjemahan, lalu dibaca dengan kuromoji. Daftar kata fungsi di bawah hanya mengatur URUTAN PRIORITAS (kata isi lebih dulu), bukan kandidat.
const STOP_WORDS = {
  en: new Set(("a an the and or but nor so if of to in on at by for with from as into than then that this these those there here it its it's i me my we us our you your he him his she her they them their " +
    "am is are was were be been being i'm i've i'll i'd you're you've you'll you'd he's he'll she's she'll we're we've we'll they're they've they'll it'll that's there's here's what's who's let's " +
    "do does did don't doesn't didn't have has had will would shall should can could may might must can't won't wouldn't couldn't shouldn't isn't aren't wasn't weren't hasn't haven't hadn't " +
    "not no yes oh uh um ah what who whom whose which where when why how all any some just very too also only about over off").split(' ')),
  id: new Set('yang dan atau tetapi tapi di ke dari untuk dengan pada dalam ini itu saya aku kamu anda dia ia kami kita mereka adalah ialah akan sudah telah sedang belum tidak bukan juga saja lagi ada ya oh nah dong kok sih lah pun karena jika kalau agar supaya bahwa sebuah seorang para si sang'.split(' ')),
};
const NOSPACE_LANGS = new Set(['zh', 'yue', 'th', 'km', 'lo', 'my']); // bahasa tanpa spasi antarkata: dipecah dengan Intl.Segmenter

function wordSpans(text, lang) { // -> [{w, s, e}] (kata beserta posisinya)
  const out = [], base = String(lang).split('-')[0].toLowerCase();
  if (NOSPACE_LANGS.has(base) && typeof Intl !== 'undefined' && Intl.Segmenter) {
    try { for (const g of new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)) if (g.isWordLike) out.push({ w: g.segment, s: g.index, e: g.index + g.segment.length }); return out; } catch { out.length = 0; }
  }
  const re = /[\p{L}\p{M}\p{N}]+(?:['\u2019\-][\p{L}\p{M}\p{N}]+)*/gu; let m;
  while ((m = re.exec(text))) out.push({ w: m[0], s: m.index, e: m.index + m[0].length });
  return out;
}

// -> pools: satu kumpulan kandidat per baris subtitle; kandidat: { phrase, key, tier } (tier 1 = diutamakan, 2 = cadangan).
// Frasa n kata hanya dibentuk dari kata yang berurutan DALAM SATU klausa (tidak melewati koma/titik/baris), tidak memuat angka atau nama diri,
// berakhir pada kata isi, dan memuat minimal satu kata isi (dua kata fungsi seperti "I am" tidak pernah menjadi frasa).
function sourcePools(lines, lang, n) {
  const base = String(lang).split('-')[0].toLowerCase(), spaced = !NOSPACE_LANGS.has(base), join = spaced ? ' ' : '';
  const stop = STOP_WORDS[base] || null, minLen = spaced ? 2 : 1;
  const norm = (w) => w.toLowerCase().replace(/[\u2019\u2018`\u00b4]/g, "'");
  const seen = new Set(), pools = [];
  for (const line of lines) {
    const text = String(line), sp = wordSpans(text, lang);
    if (!sp.length) continue;
    const upper = sp.filter((x) => /^\p{Lu}/u.test(x.w)).length, titleCase = sp.length >= 4 && upper / sp.length >= 0.8; // baris berhuruf kapital di tiap kata: huruf besar tidak menandai nama
    const gap = (i) => (i ? text.slice(sp[i - 1].e, sp[i].s) : '');
    const info = sp.map((x, i) => {
      const g = gap(i), len = [...x.w].length;
      return {
        w: x.w, brk: i > 0 && /\S/.test(g),
        skip: /\p{N}/u.test(x.w) || len < minLen || (spaced && !titleCase && i > 0 && !/[.!?\u2026\u3002\uff01\uff1f]/.test(g) && /^\p{Lu}\p{Ll}/u.test(x.w)), // angka, huruf tunggal, nama diri (kapital di tengah kalimat)
        weak: stop ? stop.has(norm(x.w)) : (spaced && len <= 2),
      };
    });
    const pool = [];
    for (let i = 0; i + n <= info.length; i++) {
      const w = info.slice(i, i + n);
      if (w.some((x, j) => x.skip || (j > 0 && x.brk))) continue;
      const strong = w.filter((x) => !x.weak).length;
      if (n > 1 && (w[n - 1].weak || !strong)) continue; // frasa: harus berakhir pada kata isi (1 kata: kata fungsi tetap boleh, tetapi tier 2)
      const phrase = w.map((x) => x.w.toLowerCase()).join(join), key = foldKey(phrase, lang);
      if (!key || seen.has(key)) continue;
      seen.add(key); pool.push({ phrase, key, tier: strong === n ? 1 : 2 });
    }
    if (pool.length) pools.push(pool);
  }
  return pools;
}

// Mengambil sampai k kandidat BERBEDA yang belum pernah ditampilkan/dilewati: tier terbaik dulu; di dalam tier, baris dipilih acak lalu kandidatnya acak.
function drawSourceBatch(pools, skip, k, rand = Math.random) {
  const taken = new Set(), out = [];
  while (out.length < k) {
    const avail = pools.map((p) => p.filter((c) => !skip.has(c.key) && !taken.has(c.key))).filter((p) => p.length);
    if (!avail.length) break;
    const tier = Math.min(...avail.map((p) => Math.min(...p.map((c) => c.tier))));
    const top = avail.map((p) => p.filter((c) => c.tier === tier)).filter((p) => p.length);
    const seg = top[Math.floor(rand() * top.length)], c = seg[Math.floor(rand() * seg.length)];
    taken.add(c.key); out.push(c);
  }
  return out;
}

// Memverifikasi hasil terjemahan Jepang: harus benar-benar tulisan Jepang yang bisa dibaca kuromoji (semua bagian punya bacaan). Tidak ada yang dikarang.
function japaneseParts(ja, tokenize, source) {
  const text = cleanText(ja);
  if (!text || text.length > 40 || !/[\u3040-\u30FF\u4E00-\u9FFF\u3005]/.test(text) || text.toLowerCase() === String(source).toLowerCase()) return null;
  let toks; try { toks = (tokenize(text) || []).filter((t) => t.pos !== '記号'); } catch { return null; }
  if (!toks.length || toks.length > 6) return null;
  toks = toks.map((t) => ({ ...t, reading: t.reading && t.reading !== '*' ? t.reading : (isKatakanaOnly(t.surface_form) ? t.surface_form : '') })); // kata katakana asing: bacaannya = tulisannya
  if (toks.some((t) => !t.reading || !/[\u3040-\u30FF\u4E00-\u9FFF\u3005]/.test(t.surface_form))) return null;
  const parts = partsOf(toks, tokenize);
  if (parts.some((p) => !p.reading || !p.romaji)) return null;
  return { surface: toks.map((t) => t.surface_form).join(''), parts };
}

// Teks non-Jepang diterjemahkan per potongan (URL layanan terjemahan ada batas panjangnya).
function translationChunks(lines, encMax = TR_ENC_MAX, maxChunks = TR_MAX_CHUNKS) {
  const chunks = []; let cur = [], len = 0;
  for (const l of lines) {
    const e = encodeURIComponent(l).length + 3;
    if (cur.length && len + e > encMax) { chunks.push(cur.join('\n')); cur = []; len = 0; }
    cur.push(l); len += e;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  if (chunks.length <= maxChunks) return chunks;
  return Array.from({ length: maxChunks }, (_, i) => chunks[Math.floor(i * chunks.length / maxChunks)]); // merata dari awal sampai akhir interval
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

// frame-src https: dan script-src animeembed.com: dibutuhkan agar pemutar iframe (AnimeEmbed, VidRift, dan situs lain) bisa tampil di dalam aplikasi.
// Referrer-Policy strict-origin-when-cross-origin: pemutar tertanam mengenali halaman induknya dari origin (sama dengan <meta name="referrer"> di index.html).
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com https://animeembed.com; frame-src https:; img-src 'self' data: https://i.ytimg.com; media-src *; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

function createServer({ fetchImpl = fetch, getTokenizer = defaultTokenizer, indexPath = path.join(__dirname, 'index.html'), supadataKey = process.env.SUPADATA_API_KEY, lookup = defaultLookup } = {}) {
  const hits = new Map();
  const cache = new Map();
  const subCache = new Map(); // subtitle disimpan SEMENTARA di memori server (20 menit) agar hemat kuota; tidak ada penyimpanan permanen

  async function loadSubs(id) {
    const hit = subCache.get(id);
    if (hit && Date.now() - hit.t < 20 * 60 * 1000) return hit.v;
    let out = null, pre = [], quota = false;
    if (supadataKey) {
      const s = await fetchViaSupadata(fetchImpl, String(supadataKey).trim(), id);
      pre = s.trace || [];
      if (s.ok || s.error === 'NO_SUBTITLE') out = s;
      quota = s.error === 'QUOTA';
    }
    if (!out) { // cadangan: langsung ke YouTube
      out = await fetchSubtitles(fetchImpl, id, supadataKey ? 3000 : 8000);
      out.trace = [...pre, ...(out.trace || [])];
      if (quota && out.error) out = { error: 'QUOTA', trace: out.trace };
    }
    if (out.ok) { if (subCache.size >= 30) subCache.delete(subCache.keys().next().value); subCache.set(id, { t: Date.now(), v: out }); }
    return out;
  }
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
        let html; try { html = fs.readFileSync(indexPath); } catch { return send(404, { ok: false, message: 'Page not found.' }); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-cache' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true });

      if (req.method === 'GET' && url.pathname === '/api/subtitles') {
        if (tooMany('sub', SUB_LIMIT)) return fail(429, 'RATE_LIMIT');
        const raw = url.searchParams.get('url') || '';
        const v = raw.length > 300 ? { error: 'BAD_LINK' } : extractVideoId(raw);
        if (v.error) return fail(400, v.error);
        let out;
        try { out = await loadSubs(v.id); } catch { return fail(502, 'UPSTREAM'); }
        return out.error ? send(out.error === 'UPSTREAM' ? 502 : 200, { ok: false, code: out.error, message: MSG[out.error], trace: (out.trace || []).join(' ').slice(0, 400) }) : send(200, out);
      }

      if (req.method === 'GET' && url.pathname === '/api/page-subtitles') { // sumber video selain YouTube
        if (tooMany('page', PAGE_LIMIT)) return fail(429, 'RATE_LIMIT');
        const raw = (url.searchParams.get('url') || '').trim();
        let target = null;
        if (raw.length <= 800) { try { const t = new URL(raw); if (t.protocol === 'https:' || t.protocol === 'http:') target = t; } catch { /* tidak valid */ } }
        if (!target) return fail(400, 'BAD_LINK');
        if (YT_HOSTS.has(target.hostname.toLowerCase())) return fail(400, 'IS_YOUTUBE');
        const pref = /^(ja|en|id)$/.test(url.searchParams.get('pref') || '') ? url.searchParams.get('pref') : 'ja';
        let out;
        try { out = await fetchPageSubtitles(fetchImpl, target.href, { lookup, pref }); } catch { return fail(502, 'PAGE_FAIL'); }
        return out.error ? send(200, { ok: false, code: out.error, message: MSG[out.error], trace: (out.trace || []).join(' ').slice(0, 400) }) : send(200, out);
      }

      if (req.method === 'POST' && url.pathname === '/api/highlight') {
        if (tooMany('hl', HL_LIMIT)) return fail(429, 'RATE_LIMIT');
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(415, { ok: false, code: 'BAD_INPUT', message: MSG.BAD_INPUT });
        let raw;
        try { raw = await readBody(req, HL_BODY_MAX); } catch { res.setHeader('Connection', 'close'); return send(413, { ok: false, code: 'BAD_INPUT', message: MSG.BAD_INPUT }); }
        let body; try { body = JSON.parse(raw); } catch { return fail(400, 'BAD_INPUT'); }
        const inp = cleanInput(body);
        if (inp.error) return fail(400, 'BAD_INPUT');

        let tokenize; try { tokenize = await getTokenizer(); } catch { return fail(503, 'NO_TOKENIZER'); }
        const isJa = inp.lang === 'ja' || inp.lang.startsWith('ja-');
        if (isJa) { // subtitle Jepang: kata dipecah kuromoji; yang sudah tampil di interval ini tidak muncul lagi
          const pools = segmentPools(tokenize, splitSegments(inp.lines.join('\n')), inp.wordCount);
          if (!pools.length) return fail(200, 'NO_WORDS'); // memang tidak ada kata
          const pick = pickFromPools(pools, inp.exclude);
          if (!pick) return fail(200, 'NO_MORE_WORDS');   // semua kata unik interval ini sudah tampil
          let id, en;
          try { [id, en] = await Promise.all([translate(fetchImpl, cache, pick.surface, 'ja', 'id'), translate(fetchImpl, cache, pick.surface, 'ja', 'en')]); } catch { return fail(502, 'TRANSLATE_FAIL'); }
          const parts = partsOf(pick.w, tokenize);
          const card = buildCard({ romaji: parts.map((p) => p.romaji).join(' '), meaning_id: id, meaning_en: en, parts }, inp.wordCount);
          return card ? send(200, { ok: true, card, surface: pick.surface, viaTranslation: false }) : fail(502, 'NO_WORDS');
        }
        // Subtitle bukan Jepang: kandidat = kata/frasa dari SELURUH teks interval; padanan Jepangnya dicari per kandidat lewat terjemahan lalu diverifikasi kuromoji.
        const sl = inp.lang.split('-')[0], base = sl.toLowerCase();
        const pools = sourcePools(inp.lines, inp.lang, inp.wordCount);
        if (!pools.length) return fail(200, 'NO_WORDS');
        const skip = new Set(inp.exclude.map((x) => foldKey(x, sl))); // riwayat interval ini (kata sumber + tulisan Jepangnya) + kandidat yang gagal diverifikasi
        const skipped = [];
        for (let round = 0; round < HL_ROUNDS; round++) {
          const batch = drawSourceBatch(pools, skip, HL_BATCH);
          if (!batch.length) break;
          const res = await Promise.allSettled(batch.map((c) => translate(fetchImpl, cache, c.phrase, sl, 'ja')));
          if (res.every((r) => r.status === 'rejected')) return fail(502, 'TRANSLATE_FAIL'); // layanan terjemahan sibuk: bukan salah kandidat, tidak dicatat
          for (let i = 0; i < batch.length; i++) {
            const c = batch[i], r = res[i];
            skip.add(c.key);
            if (r.status === 'rejected') continue; // gagal jaringan: boleh dicoba lagi di NEXT berikutnya (tidak dicatat)
            const jp = japaneseParts(r.value, tokenize, c.phrase);
            const jk = jp && foldKey(jp.surface, sl);
            if (!jp || skip.has(jk)) { skipped.push(c.key); continue; } // tidak terverifikasi / padanannya sudah pernah tampil: lewati, jangan dibuang diam-diam, catat agar tidak dicoba ulang
            let id, en;
            try { [id, en] = await Promise.all([base === 'id' ? c.phrase : translate(fetchImpl, cache, c.phrase, sl, 'id'), base === 'en' ? c.phrase : translate(fetchImpl, cache, c.phrase, sl, 'en')]); } catch { return fail(502, 'TRANSLATE_FAIL'); }
            const card = buildCard({ romaji: jp.parts.map((p) => p.romaji).join(' '), meaning_id: id, meaning_en: en, parts: jp.parts }, jp.parts.length);
            if (!card) { skipped.push(c.key); continue; }
            card.type = inp.wordCount === 1 ? 'single' : 'phrase'; // jenis kartu mengikuti pilihan "1 word / 2 words"
            return send(200, { ok: true, card, surface: jp.surface, key: c.key, skipped, viaTranslation: true });
          }
        }
        const more = drawSourceBatch(pools, skip, 1).length > 0;
        const code = more ? 'NOT_VERIFIED' : 'NO_MORE_WORDS';
        return send(200, { ok: false, code, message: MSG[code], skipped });
      }

      return send(['GET', 'POST'].includes(req.method) ? 404 : 405, { ok: false, message: 'Not found.' });
    } catch {
      return send(500, { ok: false, message: 'Something went wrong on the server.' });
    }
  });
}

module.exports = { fetchPageSubtitles, scanTracks, scanFrames, rankCandidates, langOf, isPrivateIp, assertPublicUrl, createServer, fetchViaSupadata, parseXml, parseVtt, parseCaption, extractPlayerResponse, orderTracks, fetchSubtitles, extractVideoId, parseJson3, pickTrack, captionUrl, cleanText, buildCard, cleanInput, toRomaji, toHiragana, candidates, partsOf, splitSegments, segmentPools, pickFromPools, translationChunks, sampleEvenly, foldKey, sourcePools, drawSourceBatch, japaneseParts };

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log('Aplikasi menyala di http://localhost:' + PORT);
    defaultTokenizer().then(() => console.log('Mesin kata Jepang siap.'), (e) => console.log('PERINGATAN: kuromoji belum terpasang. Jalankan: npm install  (' + e.message + ')'));
  });
}
