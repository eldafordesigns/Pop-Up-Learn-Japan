'use strict';
// Pintu masuk untuk Vercel. Semua alamat /api/... diteruskan ke dapur (server.js).
process.env.TRUST_PROXY = '1'; // di Vercel, alamat pengunjung ada di header x-forwarded-for
const { createServer } = require('../server');
const server = createServer();
module.exports = (req, res) => { server.emit('request', req, res); };
