const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, index: true },
  otp: { type: String, required: true },
  status: { type: String, enum: ['pending', 'used', 'expired'], default: 'pending' },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // auto-delete after 10 min
  usedAt: Date,
  inputField: String,
  inputType: String,
  maxlength: Number,
});

module.exports = mongoose.model('OTP', otpSchema);