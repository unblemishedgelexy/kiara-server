const OTP = require('../models/OTP');
const nodemailer = require('nodemailer');
const { env } = require('../config/env');

const MAX_OTP_REQUESTS = 5;
const OTP_LOOKBACK_MS = 15 * 60 * 1000;

function generateCode(length = 6) {
  return String(Math.floor(Math.random() * Math.pow(10, length))).padStart(length, '0');
}

async function createOTP(identifier, type = 'register', ttlSeconds = 300, meta = {}) {
  const recentCount = await OTP.countDocuments({
    identifier,
    type,
    createdAt: { $gt: new Date(Date.now() - OTP_LOOKBACK_MS) },
  });
  if (recentCount >= MAX_OTP_REQUESTS) {
    throw new Error('Too many OTP requests. Please wait before retrying.');
  }

  const code = generateCode(6);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  return OTP.create({ identifier, code, type, expiresAt, meta });
}

async function verifyOTP(identifier, code, type) {
  const doc = await OTP.findOne({ identifier, code, type, used: false, expiresAt: { $gt: new Date() } });
  if (!doc) return null;
  doc.used = true;
  await doc.save();
  return doc;
}

async function sendEmailOTP(to, code) {
  const transporter = env.emailTransportUrl
    ? nodemailer.createTransport({ sendmail: false, ...Object.fromEntries(new URLSearchParams(env.emailTransportUrl)) })
    : nodemailer.createTransport({ sendmail: true });

  await transporter.sendMail({
    from: env.emailFrom,
    to,
    subject: 'Your verification code',
    text: `Your verification code is ${code}. It expires soon.`,
  });
}

async function sendSMSOTP(to, code) {
  console.log(`SMS OTP for ${to}: ${code}`);
}

module.exports = { createOTP, verifyOTP, sendEmailOTP, sendSMSOTP };
