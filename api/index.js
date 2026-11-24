'use strict';
// Pintu masuk untuk Vercel. Semua permintaan diteruskan ke dapur (dapur.js).
process.env.TRUST_PROXY = '1'; // di Vercel, alamat pengunjung ada di header x-forwarded-for
const { createServer } = require('../dapur');
const server = createServer();
module.exports = (req, res) => { server.emit('request', req, res); };
