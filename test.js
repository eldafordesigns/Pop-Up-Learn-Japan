'use strict';
const assert = require('assert');
const S = require('./dapur');
const { parseXml, parseVtt, parseCaption, extractPlayerResponse } = S;
const { createServer, extractVideoId, parseJson3, pickTrack, captionUrl, buildCard, cleanInput, toRomaji, toHiragana, candidates } = S;

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('✅', name); }, (e) => { console.log('❌', name, '-', e.message); process.exitCode = 1; });
const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
const T = (lang, extra = {}) => ({ baseUrl: 'https://www.youtube.com/api/timedtext?lang=' + lang, languageCode: lang, ...extra });
const tok = (surface_form, pos, pos_detail_1, reading) => ({ surface_form, pos, pos_detail_1, reading });
// Pura-pura kuromoji: "かわいい猫が好き"
const TOKENS = [tok('かわいい', '形容詞', '自立', 'カワイイ'), tok('猫', '名詞', '一般', 'ネコ'), tok('が', '助詞', '格助詞', 'ガ'), tok('好き', '名詞', '形容動詞語幹', 'スキ')];
const fakeTok = (tokens = TOKENS, seen) => async () => (text) => { if (seen) seen.push(text); return tokens; };

function fake({ tracks = [], google = 'ok', seen = [] } = {}) {
  return async (url) => {
    const u = String(url); seen.push(u);
    if (u.includes('/youtubei/v1/player')) return resp(200, { videoDetails: { title: 'Tes <b>Video</b>' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } });
    if (u.includes('translate.googleapis.com')) {
      if (google.startsWith('down')) return resp(500, {});
      const tl = new URL(u).searchParams.get('tl');
      return resp(200, [[[{ ja: 'かわいい猫が好き', id: 'kucing lucu', en: 'cute cat' }[tl], 'x']]]);
    }
    if (u.includes('mymemory')) return google === 'down-all' ? resp(500, {}) : resp(200, { responseData: { translatedText: 'cadangan' } });
    return resp(200, { events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'kucing lucu' }] }, { tStartMs: 5000 }] });
  };
}
async function withServer(opts, fn) {
  const server = createServer(opts); await new Promise((r) => server.listen(0, r));
  try { return await fn('http://localhost:' + server.address().port); } finally { server.close(); }
}
const getJson = async (b, p) => { const r = await fetch(b + p); return { status: r.status, body: await r.json(), headers: r.headers }; };
const post = async (b, obj, headers = { 'Content-Type': 'application/json' }, raw) => { const r = await fetch(b + '/api/highlight', { method: 'POST', headers, body: raw ?? JSON.stringify(obj) }); return { status: r.status, body: await r.json() }; };
const link = '/api/subtitles?url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
const GOOD = (o = {}) => ({ lines: [{ text: 'kucing itu lucu' }], sourceLang: 'ja', wordCount: 2, ...o });

(async () => {
  await ok('Link YouTube dikenali; link berbahaya ditolak', () => {
    for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ']) assert.strictEqual(extractVideoId(u).id, 'dQw4w9WgXcQ');
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'http://localhost:3000', 'http://169.254.169.254/', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'bukan link', '']) assert.ok(extractVideoId(u).error, u);
    assert.strictEqual(extractVideoId('https://x.com/a/status/1').error, 'UNSUPPORTED_SITE');
    assert.throws(() => captionUrl('https://evil.com/x')); assert.throws(() => captionUrl('http://www.youtube.com/x'));
  });
  await ok('Teks subtitle dibersihkan', () => {
    const c = parseJson3({ events: [{ tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: '<script>x</script>halo\n dunia' }] }, { tStartMs: 9 }] });
    assert.strictEqual(c.length, 1); assert.strictEqual(c[0].text, 'xhalo dunia');
  });
  await ok('Pilihan subtitle: Jepang > Indonesia > Inggris > bahasa lain; buatan manusia dulu', () => {
    assert.strictEqual(pickTrack([T('en'), T('ja', { kind: 'asr' }), T('ja'), T('id')]).kind, undefined);
    assert.strictEqual(pickTrack([T('en'), T('id')]).languageCode, 'id');
    assert.strictEqual(pickTrack([T('ko', { kind: 'asr' }), T('th')]).languageCode, 'th');
    assert.strictEqual(pickTrack([]), null);
  });

  // ---- romaji & kana ----
  await ok('Romaji: kawaii, koohii, gakkou, matcha, kyou, shashin', () => {
    const t = { カワイイ: 'kawaii', コーヒー: 'koohii', ガッコウ: 'gakkou', マッチャ: 'matcha', キョウ: 'kyou', シャシン: 'shashin', ファイル: 'fairu', ティー: 'tii', ジュース: 'juusu', ニホンゴ: 'nihongo', ネコ: 'neko', ありがとう: 'arigatou', ウィキ: 'wiki' };
    for (const [k, v] of Object.entries(t)) assert.strictEqual(toRomaji(k), v, k);
    assert.strictEqual(toHiragana('ネコ'), 'ねこ');
  });

  // ---- memilih kata ----
  await ok('Pemilihan kata: partikel & kata sepele dilewati, 2 kata berurutan, exclude dihormati', () => {
    assert.deepStrictEqual(candidates(TOKENS, 1, []).map((c) => c.surface), ['かわいい', '猫', '好き']);
    assert.deepStrictEqual(candidates(TOKENS, 2, []).map((c) => c.surface), ['かわいい猫']);
    assert.deepStrictEqual(candidates(TOKENS, 1, ['猫']).map((c) => c.surface), ['かわいい', '好き']);
    assert.strictEqual(candidates([tok('を', '助詞', '格助詞', 'ヲ'), tok('、', '記号', '読点', '、')], 1, []).length, 0);
  });

  // ---- format kartu ----
  const AI2 = { romaji: 'kawaii neko', meaning_id: 'kucing lucu', meaning_en: 'cute cat', parts: [{ reading: 'かわいい', kanji: null, romaji: 'kawaii', is_katakana: false }, { reading: 'ねこ', kanji: '猫', romaji: 'neko', is_katakana: false }] };
  await ok('Format kartu 1 kata, 2 kata, dan katakana sesuai aturan', () => {
    const one = buildCard({ romaji: 'kawaii', meaning_id: 'lucu', meaning_en: 'cute', parts: [{ reading: 'かわいい', kanji: '可愛い', romaji: 'kawaii', is_katakana: false }] }, 1);
    assert.strictEqual(one.title, 'Kawaii: lucu/cute'); assert.strictEqual(one.kanji, '可愛い');
    const two = buildCard(AI2, 2);
    assert.strictEqual(two.title, 'Kawaii neko: kucing lucu/cute cat'); assert.strictEqual(two.hiragana, 'かわいいねこ'); assert.strictEqual(two.kanji, 'かわいい猫');
    assert.strictEqual(two.readingWithRomaji, 'かわいい (kawaii) ねこ (neko)'); assert.strictEqual(two.kanjiWithRomaji, 'かわいい (kawaii) 猫 (neko)');
    const k = buildCard({ romaji: 'koohii', meaning_id: 'kopi', meaning_en: 'coffee', parts: [{ reading: 'コーヒー', kanji: null, romaji: 'koohii', is_katakana: true }] }, 1);
    assert.strictEqual(k.hiragana, null); assert.strictEqual(k.katakana, 'コーヒー');
    assert.strictEqual(buildCard(AI2, 1), null); assert.strictEqual(buildCard(null, 1), null);
    assert.strictEqual(buildCard({ ...AI2, meaning_id: '<img onerror=x>lucu', parts: AI2.parts }, 2).meaningId, 'lucu');
  });
  await ok('Masukan dibatasi', () => {
    assert.ok(cleanInput({ lines: [], sourceLang: 'id' }).error);
    assert.ok(cleanInput({ lines: Array(13).fill({ text: 'a' }), sourceLang: 'id' }).error);
    assert.ok(cleanInput({ lines: [{ text: 'a' }], sourceLang: 'id; DROP' }).error);
    assert.strictEqual(cleanInput({ lines: [{ text: 'a' }], sourceLang: 'id', wordCount: 99 }).wordCount, 3);
  });

  // ---- endpoint ----
  await ok('Subtitle Korea saja tetap diterima; tanpa subtitle muncul pemberitahuan', async () => {
    await withServer({ fetchImpl: fake({ tracks: [T('ko')] }) }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.language, 'ko'); assert.strictEqual(r.body.title, 'Tes Video'); });
    await withServer({ fetchImpl: fake({ tracks: [] }) }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.code, 'NO_SUBTITLE'); assert.ok(r.body.message.includes('cari video lain')); });
  });
  await ok('Subtitle Jepang: tidak diterjemahkan ke Jepang, arti Indonesia & Inggris dari Google', () => {
    const seen = [];
    return withServer({ fetchImpl: fake({ seen }), getTokenizer: fakeTok() }, async (b) => {
      const r = await post(b, GOOD());
      assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.card.title, 'Kawaii neko: kucing lucu/cute cat'); assert.strictEqual(r.body.viaTranslation, false); assert.strictEqual(r.body.surface, 'かわいい猫');
      assert.ok(!seen.some((u) => u.includes('tl=ja')));
    });
  });
  await ok('Subtitle Indonesia: diterjemahkan dulu ke Jepang, ditandai viaTranslation', () => {
    const toks = [];
    return withServer({ fetchImpl: fake(), getTokenizer: fakeTok(TOKENS, toks) }, async (b) => {
      const r = await post(b, GOOD({ sourceLang: 'id' }));
      assert.strictEqual(r.body.viaTranslation, true); assert.strictEqual(toks[0], 'かわいい猫が好き');
    });
  });
  await ok('Google mati: pakai cadangan MyMemory; keduanya mati: pesan sopan', async () => {
    await withServer({ fetchImpl: fake({ google: 'down' }), getTokenizer: fakeTok() }, async (b) => { const r = await post(b, GOOD()); assert.strictEqual(r.body.card.meaningId, 'cadangan'); });
    await withServer({ fetchImpl: fake({ google: 'down-all' }), getTokenizer: fakeTok() }, async (b) => { const r = await post(b, GOOD()); assert.strictEqual(r.status, 502); assert.strictEqual(r.body.code, 'TRANSLATE_FAIL'); });
  });
  await ok('Tidak ada kata cocok / mesin kata belum siap: pesan jelas', async () => {
    await withServer({ fetchImpl: fake(), getTokenizer: fakeTok([tok('を', '助詞', '格助詞', 'ヲ')]) }, async (b) => assert.strictEqual((await post(b, GOOD())).body.code, 'NO_WORDS'));
    await withServer({ fetchImpl: fake(), getTokenizer: async () => { throw new Error('x'); } }, async (b) => assert.strictEqual((await post(b, GOOD())).status, 503));
  });
  await ok('Kata yang sudah tampil (exclude) tidak muncul lagi', () => withServer({ fetchImpl: fake(), getTokenizer: fakeTok() }, async (b) => {
    for (let i = 0; i < 6; i++) assert.notStrictEqual((await post(b, GOOD({ wordCount: 1, exclude: ['かわいい', '好き'] }))).body.surface, 'かわいい');
  }));
  await ok('Masukan buruk ditolak: bukan JSON, tipe salah, terlalu besar', () => withServer({ fetchImpl: fake(), getTokenizer: fakeTok() }, async (b) => {
    assert.strictEqual((await post(b, null, { 'Content-Type': 'application/json' }, '{rusak')).status, 400);
    assert.strictEqual((await post(b, GOOD(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.strictEqual((await post(b, null, { 'Content-Type': 'application/json' }, JSON.stringify({ lines: [{ text: 'x'.repeat(30000) }], sourceLang: 'id' }))).status, 413);
  }));
  await ok('Pembatas: permintaan sorotan ke-13 per menit ditolak', () => withServer({ fetchImpl: fake(), getTokenizer: fakeTok() }, async (b) => {
    let last; for (let i = 0; i < 13; i++) last = await post(b, GOOD()); assert.strictEqual(last.status, 429);
  }));
  await ok('Halaman aplikasi disajikan dengan header keamanan; metode/alamat asing ditolak', () => withServer({ fetchImpl: fake() }, async (b) => {
    const r = await fetch(b + '/');
    assert.strictEqual(r.status, 200); assert.ok((await r.text()).includes('Belajar Jepang'));
    assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'")); assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual((await fetch(b + '/server.js')).status, 404); assert.strictEqual((await fetch(b + '/../package.json')).status, 404);
    assert.strictEqual((await fetch(b + '/api/subtitles', { method: 'DELETE' })).status, 405);
  }));
  await ok('YouTube error: pesan sopan tanpa membocorkan detail', () => withServer({ fetchImpl: async () => { throw new Error('rahasia internal'); } }, async (b) => {
    const r = await getJson(b, link); assert.strictEqual(r.status, 502); assert.ok(!JSON.stringify(r.body).includes('rahasia'));
  }));

  // ---- format subtitle & cadangan ----
  const txtResp = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });
  await ok('Pembaca subtitle: XML lama, srv3, VTT (tanpa baris ganda), JSON, dan data halaman YouTube', () => {
    const x = parseXml('<transcript><text start="1.5" dur="2">Halo &amp;#39;ok&amp;#39; &amp; dunia</text></transcript>');
    assert.strictEqual(x[0].text, "Halo 'ok' & dunia"); assert.strictEqual(x[0].start, 1.5);
    const y = parseCaption('<timedtext format="3"><body><p t="2000" d="1500"><s>kucing</s><s t="200"> lucu</s></p></body></timedtext>');
    assert.strictEqual(y[0].text, 'kucing lucu'); assert.strictEqual(y[0].start, 2);
    const v = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000 align:start\nhalo <c>dunia</c>\n\n00:00:03.000 --> 00:00:05.000\nhalo dunia\n\n00:00:05.000 --> 00:00:06.000\nbaru');
    assert.deepStrictEqual(v.map((c) => c.text), ['halo dunia', 'baru']);
    assert.strictEqual(parseCaption('1\n00:00:01,000 --> 00:00:02,000\nsrt ok')[0].text, 'srt ok');
    assert.strictEqual(parseCaption('{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"j"}]}]}')[0].text, 'j');
    assert.strictEqual(parseCaption('').length, 0);
    assert.deepStrictEqual(extractPlayerResponse('<script>var ytInitialPlayerResponse = {"a":{"b":"}{"},"captions":1};var x=1;</script>'), { a: { b: '}{' }, captions: 1 });
  });
  await ok('Cadangan: pintu aplikasi ditolak -> pakai halaman tonton; JSON kosong -> coba XML', () => {
    const page = 'x<script>var ytInitialPlayerResponse = ' + JSON.stringify({ videoDetails: { title: 'Judul' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [T('ja', { kind: 'asr' })] } } }) + ';</script>';
    const f = async (url) => {
      const u = String(url);
      if (u.includes('/youtubei/v1/player')) return txtResp(403, '');
      if (u.includes('/watch?')) return txtResp(200, page);
      if (u.includes('fmt=json3')) return txtResp(200, '');
      return txtResp(200, '<timedtext><body><p t="1000" d="2000">こんにちは</p></body></timedtext>');
    };
    return withServer({ fetchImpl: f }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.language, 'ja'); assert.strictEqual(r.body.auto, true); assert.strictEqual(r.body.cues[0].text, 'こんにちは'); });
  });
  await ok('Diblokir bot / subtitle ditolak: pesan jelas + jejak singkat tanpa rahasia', async () => {
    const bot = async (url) => String(url).includes('/youtubei/v1/player') ? resp(200, { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } }) : txtResp(200, '');
    await withServer({ fetchImpl: bot }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.code, 'BOT_BLOCK'); assert.ok(r.body.message.includes('Tempel manual')); });
    const denied = async (url) => String(url).includes('/youtubei/v1/player') ? resp(200, { captions: { playerCaptionsTracklistRenderer: { captionTracks: [T('en')] } } }) : txtResp(200, '');
    await withServer({ fetchImpl: denied }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.code, 'BOT_BLOCK'); assert.ok(r.body.trace.includes('kosong')); });
  });

  await ok('Layanan Supadata: dipakai bila ada kunci, pilih Jepang, hemat kuota (cache), kuota habis dilaporkan', async () => {
    const calls = [];
    const f = async (url, o) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api.supadata.ai') throw new Error('tidak boleh ke YouTube');
      assert.strictEqual(o.headers['x-api-key'], 'KUNCI'); calls.push(u.searchParams.get('lang'));
      if (u.searchParams.get('lang') === 'ja') return resp(200, { lang: 'ja', availableLangs: ['en', 'ja'], content: [{ text: 'こんにちは', offset: 1000, duration: 2000, lang: 'ja' }] });
      return resp(200, { lang: 'en', availableLangs: ['en', 'ja'], content: [{ text: 'hello', offset: 0, duration: 1000, lang: 'en' }] });
    };
    await withServer({ fetchImpl: f, supadataKey: 'KUNCI' }, async (b) => {
      const r = await getJson(b, link); assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.language, 'ja'); assert.strictEqual(r.body.cues[0].start, 1); assert.strictEqual(r.body.cues[0].end, 3);
      assert.deepStrictEqual(calls, [null, 'ja']);
      await getJson(b, link); assert.strictEqual(calls.length, 2);
    });
    const q = async (url) => { if (new URL(String(url)).hostname === 'api.supadata.ai') return resp(429, {}); throw new Error('x'); };
    await withServer({ fetchImpl: q, supadataKey: 'KUNCI' }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.code, 'QUOTA'); });
    const none = async () => resp(206, { error: 'transcript-unavailable' });
    await withServer({ fetchImpl: none, supadataKey: 'KUNCI' }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.code, 'NO_SUBTITLE'); });
  });

  // ================= Penyelidik situs & pemutar serbaguna =================
  const { isPrivateIp, safeGet, framingVerdict, extractInfo, inspectUrl, knownEmbed } = S;
  const http = require('http');
  await ok('SSRF: alamat internal/privat dikenali', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.ok(isPrivateIp(ip), ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
  });
  await ok('SSRF: safeGet menolak alamat internal, port aneh, skema aneh, dan login di URL', async () => {
    for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://[::1]/', 'ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://example.com:8080/', 'https://example.com:22/'])
      await assert.rejects(() => safeGet(u), /PRIVATE|BAD_PORT|BAD_URL/, u);
  });
  await ok('safeGet: ikuti redirect, batasi ukuran, header huruf kecil, video cukup header, redirect berlebih ditolak', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); return res.end(); }
      if (req.url === '/b') { res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' }); return res.end('<title>Halo</title>'); }
      if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('x'.repeat(1e6)); }
      if (req.url === '/v') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end('JANGAN-DIBACA'); }
      if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port, o = { allowPrivate: true };
    try {
      const a = await safeGet(base + '/a', o); assert.strictEqual(a.status, 200); assert.ok(a.finalUrl.endsWith('/b')); assert.strictEqual(a.headers['x-frame-options'], 'DENY'); assert.ok(a.body.includes('Halo'));
      assert.ok((await safeGet(base + '/big', { ...o, maxBytes: 1000 })).body.length <= 1000);
      const v = await safeGet(base + '/v', o); assert.strictEqual(v.body, ''); assert.strictEqual(v.headers['content-type'], 'video/mp4');
      await assert.rejects(() => safeGet(base + '/loop', o), /TOO_MANY_REDIRECTS/);
    } finally { srv.close(); }
  });
  await ok('Iframe: penilaian X-Frame-Options & frame-ancestors sama seperti browser', () => {
    const O = 'https://app.example.vercel.app', v = (h) => framingVerdict(h, O);
    assert.strictEqual(v({}).allowed, true);
    assert.strictEqual(v({ 'x-frame-options': 'DENY' }).allowed, false);
    assert.strictEqual(v({ 'x-frame-options': 'SAMEORIGIN' }).allowed, false);
    assert.strictEqual(v({ 'x-frame-options': 'ALLOW-FROM https://x.com' }).allowed, true); // sudah usang, diabaikan browser
    assert.strictEqual(v({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }).allowed, false);
    assert.strictEqual(v({ 'content-security-policy': "frame-ancestors 'self'" }).allowed, false);
    assert.strictEqual(v({ 'content-security-policy': 'frame-ancestors *' }).allowed, true);
    assert.strictEqual(v({ 'content-security-policy': 'frame-ancestors https://*.vercel.app' }).allowed, true);
    assert.strictEqual(v({ 'content-security-policy': 'frame-ancestors https://app.example.vercel.app' }).allowed, true);
    assert.strictEqual(v({ 'content-security-policy': 'frame-ancestors https://lain.com https://*.lain.org' }).allowed, false);
    assert.strictEqual(v({ 'content-security-policy': 'frame-ancestors https:' }).allowed, true);
    assert.strictEqual(v({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }).allowed, true); // CSP menang atas XFO
    assert.strictEqual(v({ 'content-security-policy': "frame-ancestors 'none', frame-ancestors *" }).allowed, false);
    assert.ok(v({ 'x-frame-options': 'DENY' }).reasons[0].includes('X-Frame-Options'));
    assert.ok(v({ 'content-security-policy': "frame-ancestors 'none'" }).reasons[0].includes('frame-ancestors'));
  });
  await ok('Embed resmi: baca twitter:player, og:video, oEmbed, dan HANYA penyedia arus utama dari iframe', () => {
    const html = `<html><head><title>Judul &amp; Co</title>
      <meta name="twitter:player" content="https://pemutar.contoh.com/embed/123">
      <meta property="og:video:secure_url" content="https://cdn.contoh.com/v.mp4"><meta property="og:video:type" content="video/mp4">
      <link rel="alternate" type="application/json+oembed" href="https://contoh.com/oembed?url=x"></head><body>
      <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0"></iframe>
      <iframe data-src="https://player.vimeo.com/video/123456"></iframe>
      <iframe src="https://hoster-bebas.example/e/abc"></iframe>
      <iframe src="https://iklan.example/banner"></iframe></body></html>`;
    const i = extractInfo(html, 'https://contoh.com/watch');
    assert.strictEqual(i.title, 'Judul & Co'); assert.strictEqual(i.embed.url, 'https://pemutar.contoh.com/embed/123'); assert.strictEqual(i.embed.source, 'twitter:player');
    assert.strictEqual(i.direct.url, 'https://cdn.contoh.com/v.mp4'); assert.strictEqual(i.oembedUrl, 'https://contoh.com/oembed?url=x');
    assert.strictEqual(i.youtubeId, 'dQw4w9WgXcQ'); assert.deepStrictEqual(i.providers.map((p) => p.name), ['Vimeo']); // hoster tak dikenal TIDAK diekstrak
    assert.strictEqual(knownEmbed('https://hoster-bebas.example/e/abc'), null);
    assert.strictEqual(extractInfo('<meta name="twitter:player" content="http://10.0.0.1/x">', 'https://a.com').embed, null);
  });
  await ok('inspectUrl: video langsung, HLS, oEmbed, anti-bot Cloudflare, 403, iframe dilarang', async () => {
    const mk = (r) => async (u) => (typeof r === 'function' ? r(u) : r);
    const H = (h, status = 200, body = '', finalUrl = 'https://s.com/x') => ({ status, headers: h, body, finalUrl });
    assert.strictEqual((await inspectUrl(mk(H({ 'content-type': 'video/mp4' })), 'https://s.com/x', 'https://app.com')).kind, 'video');
    assert.strictEqual((await inspectUrl(mk(H({ 'content-type': 'application/vnd.apple.mpegurl' })), 'https://s.com/x', 'https://app.com')).kind, 'hls');
    const oe = await inspectUrl(mk((u) => u.includes('oembed') ? H({ 'content-type': 'application/json' }, 200, JSON.stringify({ html: '<iframe src="https://pemutar.s.com/e/9"></iframe>' })) : H({ 'content-type': 'text/html' }, 200, '<link type="application/json+oembed" href="https://s.com/oembed">')), 'https://s.com/x', 'https://app.com');
    assert.deepStrictEqual(oe.embed, { url: 'https://pemutar.s.com/e/9', source: 'oEmbed' });
    const cf = await inspectUrl(mk(H({ 'content-type': 'text/html', 'cf-mitigated': 'challenge' }, 403, 'Just a moment...')), 'https://s.com/x', 'https://app.com');
    assert.ok(cf.notes[0].includes('anti-bot')); assert.strictEqual(cf.framing.allowed, true);
    assert.ok((await inspectUrl(mk(H({ 'content-type': 'text/html' }, 403, 'Forbidden')), 'https://s.com/x', 'https://app.com')).notes[0].includes('403'));
    const bl = await inspectUrl(mk(H({ 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN' }, 200, '<title>T</title>')), 'https://s.com/x', 'https://app.com');
    assert.strictEqual(bl.framing.allowed, false); assert.strictEqual(bl.title, 'T');
  });
  await ok('/api/inspect: validasi, hasil, pesan galat, pembatas, header halaman', async () => {
    const get = async (u) => { if (u.includes('private')) throw new Error('PRIVATE'); return { status: 200, headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' }, body: '<title>Hai</title>', finalUrl: u }; };
    await withServer({ fetchImpl: fake(), inspectGet: get }, async (b) => {
      assert.strictEqual((await getJson(b, '/api/inspect')).status, 400);
      assert.strictEqual((await getJson(b, '/api/inspect?url=' + encodeURIComponent('javascript:alert(1)'))).status, 400);
      assert.strictEqual((await getJson(b, '/api/inspect?url=' + encodeURIComponent('https://' + 'a'.repeat(600) + '.com'))).status, 400);
      const r = await getJson(b, '/api/inspect?url=' + encodeURIComponent('https://situs.com/watch') + '&origin=' + encodeURIComponent('https://app.com'));
      assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.framing.allowed, false); assert.strictEqual(r.body.title, 'Hai');
      const p = await getJson(b, '/api/inspect?url=' + encodeURIComponent('https://private.com/x')); assert.strictEqual(p.body.code, 'INSPECT_FAIL'); assert.ok(p.body.message.includes('internal'));
      let last; for (let i = 0; i < 15; i++) last = await getJson(b, '/api/inspect?url=' + encodeURIComponent('https://situs.com/' + i)); assert.strictEqual(last.status, 429);
      const page = await fetch(b + '/'); const csp = page.headers.get('content-security-policy');
      assert.strictEqual(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin'); assert.ok(csp.includes('frame-src https:') && csp.includes('cdn.jsdelivr.net'));
    });
  });

  console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : ', semua aman'));
})();
