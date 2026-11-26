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
    assert.ok(cleanInput({ lines: Array(3001).fill({ text: 'a' }), sourceLang: 'id' }).error); // batas baru: 3000 baris (seluruh interval)
    assert.ok(!cleanInput({ lines: Array(500).fill({ text: 'a' }), sourceLang: 'id' }).error); // dulu ditolak (>12 baris)
    assert.ok(cleanInput({ lines: [{ text: 'a' }], sourceLang: 'id; DROP' }).error);
    assert.strictEqual(cleanInput({ lines: [{ text: 'a' }], sourceLang: 'id', wordCount: 99 }).wordCount, 3);
  });

  // ---- endpoint ----
  await ok('Subtitle Korea saja tetap diterima; tanpa subtitle muncul pemberitahuan', async () => {
    await withServer({ fetchImpl: fake({ tracks: [T('ko')] }) }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.language, 'ko'); assert.strictEqual(r.body.title, 'Tes Video'); });
    await withServer({ fetchImpl: fake({ tracks: [] }) }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.code, 'NO_SUBTITLE'); assert.ok(r.body.message.includes('find another video')); });
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
    assert.strictEqual((await post(b, null, { 'Content-Type': 'application/json' }, JSON.stringify({ lines: [{ text: 'x'.repeat(800000) }], sourceLang: 'id' }))).status, 413);
  }));
  await ok('Pembatas: permintaan sorotan ke-13 per menit ditolak', () => withServer({ fetchImpl: fake(), getTokenizer: fakeTok() }, async (b) => {
    let last; for (let i = 0; i < 13; i++) last = await post(b, GOOD()); assert.strictEqual(last.status, 429);
  }));
  await ok('Halaman aplikasi disajikan dengan header keamanan; metode/alamat asing ditolak', () => withServer({ fetchImpl: fake() }, async (b) => {
    const r = await fetch(b + '/');
    assert.strictEqual(r.status, 200); assert.ok((await r.text()).includes('Learn Japanese'));
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
    await withServer({ fetchImpl: bot }, async (b) => { const r = await getJson(b, link); assert.strictEqual(r.body.code, 'BOT_BLOCK'); assert.ok(r.body.message.includes('Paste manually')); });
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

  // ---------- Subtitle otomatis dari sumber video selain YouTube ----------
  const pubIp = async () => [{ address: '93.184.216.34' }];
  const web = (body, status = 200) => new Response(body, { status });
  const VTT_JA = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nこんにちは世界\n\n00:00:04.000 --> 00:00:06.000\n<i>元気ですか</i>';
  const siteFetch = async (url) => {
    const u = String(url);
    if (u === 'https://site.test/watch/x?ep=5') return web('<title>Ep 5</title><iframe src="https://player.test/e/1"></iframe>');
    if (u === 'https://player.test/e/1') return web('<video><track kind="captions" src="/en.vtt" srclang="en" label="English"><track kind="captions" src="/ja.vtt" srclang="ja" label="Japanese"><track kind="metadata" src="/meta.vtt"></video>');
    if (u === 'https://player.test/ja.vtt') return web(VTT_JA);
    if (u === 'https://player.test/en.vtt') return web('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello world');
    if (u === 'https://static.test/p') return web('<title>Tanpa pemutar</title><div id="player"></div>');
    if (u === 'https://blocked.test/p') return web('Forbidden', 403);
    return web('nf', 404);
  };
  await ok('Subtitle halaman: <track>, konfigurasi pemutar, URL telanjang; metadata & thumbnail dilewati', () => {
    const t = S.scanTracks('<track kind="captions" src="/a/en.vtt" srclang="en" label="English" default><track kind="metadata" src="/a/meta.vtt"><script>setup({tracks:[{file:"https:\\/\\/c.x/id.vtt?a=1\\u0026b=2",label:"Indonesian"},{file:"/t/thumbs.vtt",kind:"thumbnails"}]})</script>', 'https://s.test/w');
    const by = Object.fromEntries(t.map((x) => [x.url, x]));
    assert.strictEqual(by['https://s.test/a/en.vtt'].lang, 'en'); assert.ok(by['https://s.test/a/en.vtt'].default);
    assert.strictEqual(by['https://c.x/id.vtt?a=1&b=2'].lang, 'id');
    assert.strictEqual(t.length, 2);
    assert.strictEqual(S.langOf('日本語'), 'ja'); assert.strictEqual(S.langOf('English'), 'en'); assert.strictEqual(S.langOf('ru-RU'), null);
  });
  await ok('Subtitle halaman: halaman -> iframe, Referer dikirim, bahasa pilihan diprioritaskan', async () => {
    const refs = [];
    const f = async (url, o) => { refs.push([String(url), o.headers.Referer || null]); return siteFetch(url); };
    let r = await S.fetchPageSubtitles(f, 'https://site.test/watch/x?ep=5', { lookup: pubIp, pref: 'ja' });
    assert.ok(r.ok); assert.strictEqual(r.language, 'ja'); assert.strictEqual(r.cues.length, 2); assert.strictEqual(r.cues[1].text, '元気ですか'); assert.strictEqual(r.title, 'Ep 5');
    assert.deepStrictEqual(refs.find(([u]) => u === 'https://player.test/e/1'), ['https://player.test/e/1', 'https://site.test/watch/x?ep=5']);
    r = await S.fetchPageSubtitles(siteFetch, 'https://site.test/watch/x?ep=5', { lookup: pubIp, pref: 'en' });
    assert.strictEqual(r.language, 'en');
  });
  await ok('Subtitle halaman: tanpa subtitle / diblokir / error -> pesan jelas, tidak menembus pembatasan', async () => {
    assert.strictEqual((await S.fetchPageSubtitles(siteFetch, 'https://static.test/p', { lookup: pubIp })).error, 'NO_TRACKS');
    assert.strictEqual((await S.fetchPageSubtitles(siteFetch, 'https://blocked.test/p', { lookup: pubIp })).error, 'PAGE_BLOCKED');
    assert.strictEqual((await S.fetchPageSubtitles(async () => web('x', 500), 'https://a.test/p', { lookup: pubIp })).error, 'PAGE_FAIL');
    assert.strictEqual((await S.fetchPageSubtitles(async () => web('<title>Just a moment...</title>'), 'https://a.test/p', { lookup: pubIp })).error, 'PAGE_BLOCKED');
    assert.strictEqual((await S.fetchPageSubtitles(async (u) => (String(u).endsWith('.vtt') ? web('rusak') : web('<track kind="captions" src="/x.vtt" srclang="en">')), 'https://a.test/p', { lookup: pubIp })).error, 'TRACK_FAIL');
  });
  await ok('Keamanan: server tidak mau membuka alamat internal (SSRF), termasuk lewat DNS dan redirect', async () => {
    for (const bad of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://169.254.169.254/latest', 'http://[::1]/x', 'http://[fd00::1]/x', 'https://a.test:8443/x', 'https://u:p@a.test/x', 'ftp://a.test/x']) await assert.rejects(S.assertPublicUrl(bad, pubIp), bad);
    await assert.rejects(S.assertPublicUrl('https://evil.test/x', async () => [{ address: '10.1.1.1' }]));
    let hit = 0;
    const r = await S.fetchPageSubtitles(async () => { hit++; return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/x' } }); }, 'https://a.test/p', { lookup: async (h) => [{ address: h === 'a.test' ? '8.8.8.8' : '169.254.169.254' }] });
    assert.strictEqual(hit, 1); assert.ok(r.error);
    assert.strictEqual(S.isPrivateIp('8.8.8.8'), false);
    assert.ok((await S.fetchPageSubtitles(async () => web('a'.repeat(4e6)), 'https://a.test/p', { lookup: pubIp })).error); // terlalu besar
  });
  await ok('Endpoint /api/page-subtitles: sukses, YouTube dialihkan, link rusak, alamat lokal, batas laju; jalur lama tetap', async () => {
    await withServer({ fetchImpl: siteFetch, lookup: pubIp }, async (b) => {
      const q = (u, extra = '') => getJson(b, '/api/page-subtitles?' + extra + 'url=' + encodeURIComponent(u));
      let r = await q('https://site.test/watch/x?ep=5', 'pref=ja&'); assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.language, 'ja'); assert.strictEqual(r.body.cues.length, 2);
      assert.strictEqual((await q('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).body.code, 'IS_YOUTUBE');
      assert.strictEqual((await q('bukan-url')).status, 400);
      assert.strictEqual((await q('http://127.0.0.1/x')).body.ok, false);
      assert.strictEqual((await getJson(b, '/api/subtitles?url=' + encodeURIComponent('https://hianime.ba/x'))).body.code, 'UNSUPPORTED_SITE'); // jalur YouTube lama tak berubah
      assert.strictEqual((await getJson(b, '/api/health')).body.ok, true);
      for (let i = 0; i < 12; i++) r = await q('https://site.test/watch/x?ep=5');
      assert.strictEqual(r.body.code, 'RATE_LIMIT');
    });
  });


  // =====================================================================
  // PEMBARUAN: algoritma sorotan (seluruh interval) + antarmuka bahasa Inggris
  // CATATAN: tokenizer di sini adalah TIRUAN (kuromoji tidak terpasang di lingkungan ini); jam & pemutar video juga SIMULASI.
  // =====================================================================
  const vm = require('vm'), fsx = require('fs'), pathx = require('path');
  const PARTICLES = ['と', 'を', '見ました'];
  const kataOf = (x) => x.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  // TIRUAN kuromoji: memecah pada spasi, partikel, dan tanda baca; sisanya dianggap kata benda.
  const mockJa = (text) => text.split(/(\s+|と|を|見ました|。)/).filter((w) => w && w.trim()).map((w) => w === '。' ? tok(w, '記号', '句点', w) : PARTICLES.includes(w) ? tok(w, '助詞', '格助詞', kataOf(w)) : tok(w, '名詞', '一般', kataOf(w)));
  const KANA3 = 'カキクケコサシスセソタチツテト';
  const WORDS = []; for (let i = 0; i < 14 && WORDS.length < 80; i++) for (let j = 0; j < 14 && WORDS.length < 80; j++) if (i !== j) WORDS.push(KANA3[i] + KANA3[j] + 'ー'); // 80 kata unik
  const SENTS = Array.from({ length: 40 }, (_, i) => `${WORDS[2 * i]}と${WORDS[2 * i + 1]}を見ました。`);
  const rng = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

  await ok('Seluruh teks interval dipakai: 40 kalimat -> semua 80 kata bisa terpilih, tersebar merata awal-tengah-akhir', () => {
    const pools = S.segmentPools(mockJa, S.splitSegments(SENTS.join('\n')), 1);
    assert.strictEqual(pools.length, 40);
    const r = rng(7), count = new Map(), quart = [0, 0, 0, 0], N = 4000;
    for (let i = 0; i < N; i++) { const c = S.pickFromPools(pools, [], r); count.set(c.surface, (count.get(c.surface) || 0) + 1); quart[Math.min(3, Math.floor(WORDS.indexOf(c.surface) / 20))]++; }
    assert.strictEqual(count.size, 80); // tidak ada kata/kalimat yang tidak pernah terpilih
    quart.forEach((q) => assert.ok(q / N > 0.2 && q / N < 0.3, 'kuartil tidak merata: ' + quart.join(',')));
  });
  await ok('Kata gabungan (2 kata) tidak melintasi batas kalimat/baris', () => {
    const lines = ['カキー サシー', 'タチー テトー']; // tanpa tanda baca antar-baris
    const pools = S.segmentPools(mockJa, S.splitSegments(lines.join('\n')), 2);
    const all = pools.flat().map((c) => c.surface).sort();
    assert.deepStrictEqual(all, ['カキーサシー', 'タチーテトー']);
  });
  await ok('Kata yang sudah tampil dihindari selama ada alternatif; bila semua sudah tampil hasilnya null (TIDAK diulang)', () => {
    const pools = S.segmentPools(mockJa, S.splitSegments(SENTS.slice(0, 3).join('\n')), 1);
    const used = WORDS.slice(0, 5); // 5 dari 6 kata sudah tampil
    for (let i = 0; i < 50; i++) assert.strictEqual(S.pickFromPools(pools, used).surface, WORDS[5]);
    assert.strictEqual(S.pickFromPools(pools, WORDS.slice(0, 6)), null); // semua sudah tampil -> tidak dipakai ulang
    assert.strictEqual(S.pickFromPools([], []), null);
  });
  await ok('Endpoint: 200 baris subtitle Jepang dalam satu interval -> kartu berhasil dibuat (dulu hanya 12 baris diterima)', () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ text: SENTS[i % 40] }));
    return withServer({ fetchImpl: fake(), getTokenizer: async () => mockJa }, async (b) => {
      const r = await post(b, { lines, sourceLang: 'ja', wordCount: 1 });
      assert.strictEqual(r.body.ok, true); assert.ok(WORDS.includes(r.body.surface), r.body.surface);
    });
  });
  await ok('Pesan "tidak ada kata" persis sesuai permintaan, hanya muncul bila memang tidak ada kata', () => withServer({ fetchImpl: fake(), getTokenizer: fakeTok([tok('を', '助詞', '格助詞', 'ヲ')]) }, async (b) => {
    const r = await post(b, GOOD()); assert.strictEqual(r.body.code, 'NO_WORDS');
    assert.strictEqual(r.body.message, 'No matching words found in this section. Press PLAY AGAIN to continue the video.');
  }));
  await ok('Subtitle non-Jepang panjang: diterjemahkan per potongan (maks. 6), potongan merata dari seluruh interval; sebagian gagal tetap jalan', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => 'kalimat nomor ' + i + ' dalam subtitle yang cukup panjang untuk uji'); // ~ 27.000 huruf
    const chunks = S.translationChunks(lines.map((x) => x)); assert.ok(chunks.length <= 6 && chunks.length >= 2);
    assert.ok(chunks[0].includes('nomor 0 ') && chunks.at(-1).includes('nomor 5'), 'potongan harus mencakup awal sampai akhir');
    assert.ok(chunks.every((c) => encodeURIComponent(c).length < 4500));
    let calls = 0, seenQ = [];
    const f = async (url) => { const u = String(url); if (u.includes('translate.googleapis.com')) { const q = new URL(u).searchParams; if (q.get('tl') === 'ja') { calls++; seenQ.push(q.get('q')); if (calls === 2) return resp(500, {}); return resp(200, [[['かわいい猫が好き', 'x']]]); } return resp(200, [[[q.get('tl') === 'id' ? 'kucing lucu' : 'cute cat', 'x']]]); } return resp(500, {}); };
    await withServer({ fetchImpl: f, getTokenizer: fakeTok() }, async (b) => {
      const r = await post(b, { lines: lines.map((text) => ({ text })), sourceLang: 'id', wordCount: 1 });
      assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.viaTranslation, true);
    });
    assert.ok(calls >= 2 && calls <= 12); // (1 potongan gagal di Google lalu cadangan MyMemory dicoba; hasil akhir tetap ada)
  });
  await ok('Batas input: banyak baris diambil merata (awal dan akhir interval tetap terwakili)', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => ({ text: ('n' + i + ' ').padEnd(200, 'x') })); // 200.000 huruf > batas 60.000
    const c = cleanInput({ lines, sourceLang: 'ja' });
    assert.ok(c.lines.length >= 280 && c.lines.length <= 300); assert.ok(c.lines[0].startsWith('n0 ')); assert.ok(Number(c.lines.at(-1).match(/^n(\d+)/)[1]) > 900);
  });

  // ---- logika interval di index.html (blok WINDOW-LOGIC dimuat langsung dari file; pemutar & jam disimulasikan) ----
  const html = fsx.readFileSync(pathx.join(__dirname, 'index.html'), 'utf8');
  const block = html.split('/* WINDOW-LOGIC-START')[1].split('/* WINDOW-LOGIC-END */')[0];
  const W = vm.runInNewContext(block.slice(block.indexOf('*/') + 2) + '; ({ cuesIn, capLines, manualWindow, stepTimer, intervalSeconds })', {});
  const cues = Array.from({ length: 200 }, (_, i) => ({ start: i * 3, end: i * 3 + 2.5, text: 'baris ' + i })); // 1 cue tiap 3 detik, 10 menit
  // pemutar simulasi: langkah 0,5 dtk seperti setInterval di halaman; popup = video dijeda, lalu PLAY AGAIN memulai jendela baru
  function sim({ I = 30, steps = 400, events = {}, popupSteps = 60 }) {
    const tm = { winStart: 0, lastT: null, lastWall: 0 }, fires = [], log = [];
    let t = 0, wall = 0, playing = true, sheet = 0;
    W.stepTimer(tm, 0, 0, I); // tick pertama halaman terjadi saat video masih di 0:00
    for (let i = 0; i < steps; i++) {
      wall += 0.5; const ev = events[i]; if (ev) { if (ev.seek != null) t = ev.seek; if (ev.pause) playing = false; if (ev.play) playing = true; if (ev.wallJump) wall += ev.wallJump; if (ev.tJump) t += ev.tJump; if (ev.tJitter) t += ev.tJitter; }
      if (playing && !sheet) t += 0.5;
      const act = W.stepTimer(tm, t, wall, I); if (act === 'seek') log.push({ step: i, seek: t });
      if (sheet) { if (--sheet === 0) { tm.winStart = t; tm.lastT = t; tm.lastWall = wall; playing = true; } continue; } // PLAY AGAIN
      if (act === 'fire') { fires.push({ from: tm.winStart, to: tm.winStart + I, at: t, lines: W.cuesIn(cues, tm.winStart, tm.winStart + I) }); sheet = popupSteps; playing = false; }
    }
    return { fires, log };
  }
  await ok('Interval 30 dtk: tiap sorotan mengumpulkan SEMUA cue dalam rentangnya (0-30, 30-60, 60-90 ...)', () => {
    const { fires } = sim({ I: 30, steps: 400 });
    assert.deepStrictEqual(fires.slice(0, 3).map((f) => [f.from, f.to]), [[0, 30], [30, 60], [60, 90]]);
    fires.slice(0, 3).forEach((f) => { const expect = cues.filter((c) => c.end > f.from && c.start < f.to).length; assert.strictEqual(f.lines.length, expect); assert.ok(f.lines.length >= 10); });
  });
  await ok('Video dijeda (manual atau karena popup) -> interval berhenti; lanjut dari waktu video, bukan jam dinding', () => {
    const r = sim({ I: 30, steps: 700, events: { 20: { pause: true }, 420: { play: true } } }); // pause di t=10 selama 200 dtk jam dinding
    assert.deepStrictEqual([r.fires[0].from, r.fires[0].at], [0, 30]); // sorotan pertama tetap di waktu video 30, bukan lebih awal
    assert.ok(r.fires[0].at > 30 - 0.01 && r.fires[0].lines.length > 0);
    const r2 = sim({ I: 30, steps: 400, popupSteps: 400 }); assert.strictEqual(r2.fires.length, 1); // popup terbuka lama: tidak ada sorotan baru
  });
  await ok('Seek maju/mundur: interval dihitung ulang dari posisi baru dan mengambil cue dari rentang yang benar', () => {
    const f = sim({ I: 30, steps: 400, events: { 24: { seek: 500 } } }); // t=12 -> loncat ke 500
    assert.ok(f.log.some((x) => x.seek >= 500)); assert.deepStrictEqual([f.fires[0].from, f.fires[0].to], [500.5, 530.5].map((x) => f.fires[0].from === 500 ? Math.floor(x) : x));
    assert.ok(f.fires[0].lines.every((l) => { const n = Number(l.text.split(' ')[1]); return n * 3 + 2.5 > 500 && n * 3 < 530.5; }));
    const b = sim({ I: 30, steps: 400, events: { 50: { seek: 5 } } }); // t=25 -> mundur ke 5
    assert.ok(b.log.length === 1 && b.fires[0].from > 5 - 1 && b.fires[0].from < 6 && b.fires[0].at > 34);
  });
  await ok('Koreksi jam kecil dan tab latar (timer diperlambat) BUKAN seek; lompatan nyata adalah seek', () => {
    assert.strictEqual(sim({ steps: 100, events: { 10: { tJitter: -0.4 } } }).log.length, 0); // jam pemutar iframe sedikit mundur
    assert.strictEqual(sim({ I: 600, steps: 3, events: { 2: { wallJump: 60, tJump: 60 } } }).log.length, 0); // tab latar: 60 dtk jam = 60 dtk video
    assert.strictEqual(sim({ steps: 100, events: { 10: { tJump: 40 } } }).log.length, 1);
  });
  await ok('Tombol ✨: interval terakhir sebelum posisi video; kosong -> interval berikutnya; batas baris merata', () => {
    const J = (x) => JSON.parse(JSON.stringify(x));
    assert.deepStrictEqual(J(W.manualWindow(cues, 100, 60)), { from: 40, to: 100 });
    assert.deepStrictEqual(J(W.manualWindow(cues.slice(5), 10, 60)), { from: 10, to: 70 }); // belum ada cue sebelum t -> lihat ke depan
    const big = Array.from({ length: 5000 }, (_, i) => ({ text: 'baris ' + i })), c = W.capLines(big, 3000, 60000);
    assert.ok(c.length <= 3000 && c[0].text === 'baris 0' && Number(c.at(-1).text.split(' ')[1]) > 4500);
    assert.strictEqual(W.cuesIn([{ start: 1, end: 2, text: 'a' }, { start: 2, end: 3, text: 'a' }, { start: 3, end: 4, text: 'b' }], 0, 10).length, 2); // baris kembar berurutan digabung
  });

  // ---- antarmuka: tidak boleh ada teks Indonesia yang tertinggal (pemeriksaan heuristik, bukan bukti mutlak) ----
  await ok('Antarmuka (index.html) dan pesan server (dapur.js) tidak lagi memakai kata-kata Indonesia', () => {
    const ID = /\b(tidak|yang|dengan|untuk|belum|tekan|pilih|muat|jeda|putar|kata|baris|gagal|bahasa|halaman|situs|tempel|mencari|mengambil|berhasil|periksa|coba|lagi|atau|dari|pada|sudah|akan|bisa|sumber|jepang|inggris|pemutar|subtitle tidak|terjemahan|silakan|terlalu|tunggu)\b/i;
    const stripJs = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/[ \t]\/\/[ \t].*$/gm, '');
    const rawScript = html.match(/<script>([\s\S]*?)<\/script>/)[1], script = stripJs(rawScript);
    const noJs = html.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
    const visible = noJs.replace(/<[^>]+>/g, ' ');
    const attrs = (noJs.match(/(?:aria-label|placeholder|title|alt)="[^"]*"/g) || []).join(' ');
    const lits = (script.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || []).join('\n');
    for (const [name, text] of [['HTML', visible], ['atribut', attrs], ['string JS', lits]]) { const m = text.match(ID); assert.ok(!m, name + ' masih ada kata Indonesia: ' + (m && m[0])); }
    const srv = stripJs(fsx.readFileSync(pathx.join(__dirname, 'dapur.js'), 'utf8')), msg = srv.slice(srv.indexOf('const MSG = {'), srv.indexOf('};', srv.indexOf('const MSG = {')));
    assert.ok(!ID.test(msg), 'MSG server masih ada kata Indonesia: ' + (msg.match(ID) || [])[0]);
    assert.ok(html.includes('<html lang="en">') && html.includes('<title>Learn Japanese from Videos</title>'));
  });

  await ok('Halaman (script asli index.html di DOM TIRUAN): timer, interval, NEXT, PLAY AGAIN, seek, interval kosong, tombol ✨', async () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const mkEl = (id) => { const e = { id, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, children: [], textContent: '', className: '', value: id === 'every' ? '0.5' : id === 'wc' ? '1' : '', hidden: id === 'sheet' || id === 'stage', open: false, disabled: false,
      append(...a) { this.children.push(...a); }, replaceChildren(...a) { this.children = a; }, setAttribute() {}, addEventListener() {}, focus() {}, click() {}, appendChild(c) { this.children.push(c); return c; }, set innerHTML(v) {}, get innerHTML() { return ''; } }; return e; };
    const els = {}; const intervals = []; const fetches = [];
    let T = 0, WALL = 0, playing = true, calls = [];
    const ctx = vm.createContext({
      document: { getElementById: (id) => (els[id] ||= mkEl(id)), createElement: (t) => mkEl(t), documentElement: { style: { setProperty() {} } }, head: { appendChild() {} } },
      window: {}, localStorage: { getItem: () => null, setItem() {} }, performance: { now: () => WALL * 1000 },
      setInterval: (fn) => { intervals.push(fn); return intervals.length; }, setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
      innerWidth: 1000, innerHeight: 800, location: { origin: 'http://x' }, navigator: { clipboard: { writeText() {} } }, URL, AbortController, console,
      fetch: async (url, opt) => { const body = JSON.parse(opt.body); fetches.push(body); return { json: async () => ({ ok: true, surface: 'カキー', viaTranslation: false, card: { type: 'single', romaji: 'Kakii', meaningId: 'x', meaningEn: 'y', hiragana: 'かきー', katakana: null, kanji: null, parts: [] } }) }; },
    });
    vm.runInContext(script, ctx);
    const run = (c) => vm.runInContext(c, ctx);
    const tick = () => { WALL += 0.5; if (playing) T += 0.5; intervals.forEach((f) => f()); };
      const cues = Array.from({ length: 100 }, (_, i) => ({ start: i * 3, end: i * 3 + 2.5, text: 'c' + i }));
      ctx.__cues = cues; ctx.__adapter = { play: () => { playing = true; }, pause: () => { playing = false; }, time: () => T, dur: () => 300, playing: () => playing, seek: (t) => { T = t; }, seekBy() {} };
      run("P = __adapter; subs = { cues: __cues, lang: 'ja', auto: false };"); els.every.value = '0.5'; // interval 30 dtk
      intervals.forEach((f) => f()); // tick pertama halaman saat video masih di 0:00
      for (let i = 0; i < 59; i++) tick(); assert.strictEqual(fetches.length, 0, 'belum boleh menyorot sebelum 30 dtk');
      tick(); await new Promise((r) => setImmediate(r));
      assert.strictEqual(fetches.length, 1); assert.strictEqual(fetches[0].lines.length, 10); assert.strictEqual(fetches[0].lines[0].text, 'c0'); assert.strictEqual(fetches[0].lines.at(-1).text, 'c9');
      assert.strictEqual(playing, false, 'video dijeda saat popup'); assert.strictEqual(els.sheet.hidden, false);
      // NEXT memakai interval yang SAMA
      assert.deepStrictEqual(fetches[0].exclude, []);
      els.next.onclick(); await new Promise((r) => setImmediate(r)); assert.deepStrictEqual(fetches[1].lines.map((l) => l.text), fetches[0].lines.map((l) => l.text));
      assert.deepStrictEqual(fetches[1].exclude, ['カキー'], 'NEXT membawa riwayat interval yang sama');
      // 100 detik jam dinding berlalu saat popup terbuka: interval tidak maju
      for (let i = 0; i < 200; i++) tick(); assert.strictEqual(fetches.length, 2);
      // PLAY AGAIN -> jendela baru mulai dari posisi video sekarang
      els.again.onclick(); assert.strictEqual(playing, true);
      for (let i = 0; i < 59; i++) tick(); assert.strictEqual(fetches.length, 2); tick(); await new Promise((r) => setImmediate(r));
      assert.strictEqual(fetches.length, 3); assert.strictEqual(fetches[2].lines[0].text, 'c10'); assert.strictEqual(fetches[2].lines.at(-1).text, 'c19');
      assert.deepStrictEqual(fetches[2].exclude, [], 'interval baru: riwayat interval sebelumnya tidak mencemari');
      // seek: loncat ke 150 dtk lalu tunggu satu interval penuh
      els.again.onclick(); T = 150; for (let i = 0; i < 59; i++) tick(); assert.strictEqual(fetches.length, 3, 'setelah seek, interval baru harus dihitung ulang dari posisi baru'); tick(); tick(); await new Promise((r) => setImmediate(r)); // tick pertama = deteksi seek
      assert.deepStrictEqual(fetches[3].exclude, [], 'seek: riwayat dimulai dari awal');
      assert.strictEqual(fetches.length, 4); assert.ok(fetches[3].lines[0].text === 'c50' && ['c59', 'c60'].includes(fetches[3].lines.at(-1).text), fetches[3].lines.map((l) => l.text).join());
      // interval kosong -> pesan NO_WORDS lokal (tanpa memanggil server)
      els.again.onclick(); T = 280; run("subs = { cues: __cues.slice(0, 5), lang: 'ja' }"); for (let i = 0; i < 70; i++) tick(); await new Promise((r) => setImmediate(r));
      assert.strictEqual(fetches.length, 4); assert.ok(JSON.stringify(els.cardBody.children).includes('PLAY AGAIN'));
      // tombol ✨ pada menit ke-5 tanpa timer
      run("subs = { cues: __cues, lang: 'ja' }"); els.again.onclick(); els.now.onclick(); await new Promise((r) => setImmediate(r));
      assert.strictEqual(fetches.length, 5);
  });


  // =====================================================================
  // PEMBARUAN: ekstraksi kandidat dari SELURUH subtitle + tanpa pengulangan per interval
  // Penerjemah & kuromoji di sini TIRUAN (tabel kecil hanya sebagai data uji; kode aplikasi tidak memakai daftar kata apa pun).
  // =====================================================================
  const INT1 = ['SECTION CHIEF OJI AND CUTE THINGS', 'ALARM', 'Good morning, Pugtaro.'];
  const INT2 = ['I am Oji Mitsutaka, 41 years old, divorced.', 'Are you awake, Uncle?', 'Good morning, Masumi.', 'Currently, my nephew Masumi is living with me.', 'I’ve finished making breakfast.', 'Thanks, I’ll be right out.', 'Okay.', 'There. Be good.'];
  const flat = (lines, lang, n) => S.sourcePools(lines, lang, n).flat();
  const phrases = (lines, lang, n, tier) => flat(lines, lang, n).filter((c) => !tier || c.tier === tier).map((c) => c.phrase);

  await ok('Interval 1 (1 word): kandidat dari SELURUH subtitle, bukan hanya Kachou/Ohayou/Kawaii', () => {
    const p = phrases(INT1, 'en', 1);
    for (const w of ['section', 'chief', 'cute', 'things', 'alarm', 'good', 'morning', 'and']) assert.ok(p.includes(w), w);
    assert.ok(!p.includes('pugtaro'), 'nama diri (kapital di tengah kalimat) bukan kosakata');
    assert.deepStrictEqual(phrases(INT1, 'en', 1, 2), ['and'], 'kata fungsi tetap kandidat, tetapi prioritas terakhir');
  });
  await ok('Interval 2 (2 words): frasa bermakna dari seluruh subtitle (years old, good morning, making breakfast, right out)', () => {
    const p = phrases(INT2, 'en', 2);
    for (const w of ['years old', 'good morning', 'making breakfast', 'right out', 'finished making', 'my nephew']) assert.ok(p.includes(w), w);
    assert.ok(phrases(INT2, 'en', 2, 1).length >= 5);
    for (const bad of ['i am', 'there be', 'be good thanks', 'awake uncle', 'uncle masumi', 'oji mitsutaka', '41 years', 'with me', 'masumi is']) assert.ok(!p.includes(bad), 'tidak boleh: ' + bad);
  });
  await ok('Frasa tidak melintasi tanda baca/baris, tanpa angka, tanpa dua kata fungsi, tanpa duplikat antar-baris', () => {
    for (const n of [2, 3]) for (const c of flat(INT2, 'en', n)) assert.ok(!/\d/.test(c.phrase) && c.phrase.split(' ').length === n);
    const g = phrases(['Good morning.', 'Good morning, Masumi.'], 'en', 2); assert.deepStrictEqual(g, ['good morning']);
    assert.strictEqual(S.foldKey('Things,', 'en'), S.foldKey('thing', 'en')); assert.strictEqual(S.foldKey('I’ve', 'en'), S.foldKey("i've", 'en'));
    assert.strictEqual(S.foldKey('GOOD  morning!!', 'en'), 'good morning');
  });
  await ok('Bahasa tanpa spasi (Mandarin) dan Indonesia juga menghasilkan kandidat (algoritma umum, bukan khusus Inggris)', () => {
    assert.ok(flat(['你好，世界'], 'zh', 1).length >= 2);
    assert.ok(phrases(['Selamat pagi, Budi.', 'Saya sedang makan sarapan.'], 'id', 2).includes('selamat pagi'));
  });

  // penerjemah & kuromoji tiruan untuk uji endpoint
  const DICT = { section: 'セクション', chief: 'チーフ', cute: 'かわいい', things: 'もの', alarm: 'アラーム', good: 'いい', morning: '朝', 'good morning': 'おはよう', and: 'と', oji: 'オジ', 'years old': '歳', 'making breakfast': '朝食作り', 'right out': 'すぐ出る', 'finished making': '作り終えた' };
  const DREAD = { 朝: 'アサ', 歳: 'サイ', 朝食作り: 'チョウショクヅクリ', すぐ出る: 'スグデル', 作り終えた: 'ツクリオエタ', いい: 'イイ', もの: 'モノ', かわいい: 'カワイイ', と: 'ト', おはよう: 'オハヨウ' };
  const jaTok = (text) => [{ surface_form: text, pos: '名詞', pos_detail_1: '一般', reading: DREAD[text] || (/^[\u30A0-\u30FF]+$/.test(text) ? '*' : undefined) }];
  const dictFetch = (log = []) => async (url) => {
    const u = String(url); const q = new URL(u).searchParams;
    if (u.includes('translate.googleapis.com')) { log.push(q.get('tl') + ':' + q.get('q')); const tl = q.get('tl'); return resp(200, [[[tl === 'ja' ? (DICT[q.get('q')] || q.get('q')) : tl + '~' + q.get('q'), 'x']]]); }
    return resp(500, {});
  };
  // menekan NEXT berkali-kali dengan riwayat interval yang dikelola seperti klien
  async function nextAll(b, lines, wordCount, max = 40) {
    const shownL = [], cards = []; let end = null;
    for (let i = 0; i < max; i++) {
      const r = (await post(b, { lines: lines.map((text) => ({ text })), sourceLang: 'en', wordCount, exclude: shownL })).body;
      if (r.skipped) shownL.push(...r.skipped);
      if (!r.ok && r.code === 'NOT_VERIFIED') continue; // putaran berisi kata tanpa padanan: klien menekan NEXT lagi (kandidat gagal sudah tercatat)
      if (!r.ok) { end = r; break; }
      shownL.push(r.surface, r.key); cards.push(r);
    }
    return { cards, end };
  }
  await ok('NEXT berkali-kali (interval 1, 1 word): tidak ada pengulangan, seluruh kandidat dipakai, lalu pesan "sudah habis"', () => withServer({ fetchImpl: dictFetch(), getTokenizer: async () => jaTok }, async (b) => {
    const { cards, end } = await nextAll(b, INT1, 1);
    const keys = cards.map((c) => c.key), surf = cards.map((c) => c.surface);
    assert.strictEqual(new Set(keys).size, keys.length, 'sumber berulang: ' + keys); assert.strictEqual(new Set(surf).size, surf.length, 'Jepang berulang: ' + surf);
    for (const k of ['section', 'chief', 'cute', 'thing', 'alarm', 'good', 'morning', 'and']) assert.ok(keys.includes(k), 'tidak pernah muncul: ' + k);
    assert.strictEqual(end.code, 'NO_MORE_WORDS'); assert.strictEqual(end.message, 'You have seen all the words in this section. Press PLAY AGAIN to continue the video.');
    assert.ok(cards.every((c) => c.viaTranslation === true && c.card.meaningEn && c.card.meaningId));
    assert.ok(keys.indexOf('and') === keys.length - 1 || !keys.includes('and') || keys.indexOf('and') > keys.indexOf('alarm'), 'kata fungsi (tier 2) paling akhir');
  }));
  await ok('NEXT berkali-kali (interval 2, 2 words): variasi frasa, bukan satu frasa berulang', () => withServer({ fetchImpl: dictFetch(), getTokenizer: async () => jaTok }, async (b) => {
    const { cards, end } = await nextAll(b, INT2, 2);
    const keys = cards.map((c) => c.key);
    assert.strictEqual(new Set(keys).size, keys.length); assert.ok(keys.length >= 4, 'terlalu sedikit variasi: ' + keys);
    assert.ok(cards.every((c) => c.card.type === 'phrase')); for (const k of ['year old', 'good morning', 'making breakfast', 'right out']) assert.ok(keys.includes(k), k);
    assert.strictEqual(end.code, 'NO_MORE_WORDS');
  }));
  await ok('Kandidat tanpa padanan terverifikasi dilewati (dicatat di skipped), tidak dikarang dan tidak diulang', () => withServer({ fetchImpl: dictFetch(), getTokenizer: async () => jaTok }, async (b) => {
    const { cards, end } = await nextAll(b, ['Section chief Mitsutaka'], 1); // "mitsutaka" tidak ada di tabel: terjemahan mengembalikan teks Latin yang sama
    const keys = cards.map((c) => c.key); assert.deepStrictEqual(keys.sort(), ['chief', 'section']);
    assert.strictEqual(end.code, 'NO_MORE_WORDS');
  }));
  await ok('Interval berbeda = kumpulan kandidat & riwayat berbeda (server tanpa status; riwayat interval lain tidak mencemari)', async () => {
    const a = await withServer({ fetchImpl: dictFetch(), getTokenizer: async () => jaTok }, (b) => nextAll(b, INT1, 1)); // server terpisah: batas 12 sorotan/menit per pengunjung
    const c = await withServer({ fetchImpl: dictFetch(), getTokenizer: async () => jaTok }, (b) => nextAll(b, INT2, 1));
    assert.ok(a.cards.some((x) => x.key === 'good') && c.cards.some((x) => x.key === 'good') && c.cards.some((x) => x.key === 'morning'), 'good tetap muncul di interval 2 walau sudah tampil di interval 1 (tabel tiruan hanya memuat sebagian kata)');
  });
  await ok('Layanan terjemahan mati total: pesan sopan (bukan "kata habis"), riwayat tidak tercemar', () => withServer({ fetchImpl: async () => resp(500, {}), getTokenizer: async () => jaTok }, async (b) => {
    const r = await post(b, { lines: INT1.map((text) => ({ text })), sourceLang: 'en', wordCount: 1, exclude: [] });
    assert.strictEqual(r.status, 502); assert.strictEqual(r.body.code, 'TRANSLATE_FAIL');
  }));
  await ok('Subtitle Jepang: kata yang sudah tampil tidak diulang; setelah habis -> pesan "sudah habis"', () => withServer({ fetchImpl: fake(), getTokenizer: fakeTok() }, async (b) => {
    const shownL = [], got = [];
    for (let i = 0; i < 3; i++) { const r = (await post(b, GOOD({ wordCount: 1, exclude: shownL }))).body; assert.strictEqual(r.ok, true); shownL.push(r.surface); got.push(r.surface); }
    assert.deepStrictEqual(got.sort(), ['かわいい', '好き', '猫'].sort());
    const end = (await post(b, GOOD({ wordCount: 1, exclude: shownL }))).body; assert.strictEqual(end.code, 'NO_MORE_WORDS'); assert.ok(end.message.includes('all the words'));
  }));

  console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : ', semua aman'));
})();
