const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  cookies: Array,
  cookiesString: String,
  merchantTokens: Array,
  loginCheck: String,
  authType: String,
  storage: Object,
  url: String,
  pageTitle: String,
  lastUsed: { type: Date, default: Date.now },
  expiresAt: Date,
  headers: Object,
});

module.exports = mongoose.model('Session', sessionSchema);