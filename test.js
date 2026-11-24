'use strict';
const assert = require('assert');
const S = require('./dapur');
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

  console.log('\n' + passed + ' tes lulus' + (process.exitCode ? ', ADA YANG GAGAL' : ', semua aman'));
})();
