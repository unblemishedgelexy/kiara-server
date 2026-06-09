const OTP = require('../models/OTP');
const twilio = require('twilio');
const { env, isProductionEnv } = require('../config/env');
const { EMAIL_OTP_TYPES, MOBILE_OTP_TYPES } = require('../config/otpTypes');
const { sendOTPEmail } = require('./emailService');

const MAX_OTP_REQUESTS = 5;
const OTP_LOOKBACK_MS = 15 * 60 * 1000;

function generateCode(length = 6) {
  return String(Math.floor(Math.random() * Math.pow(10, length))).padStart(length, '0');
}

class SmsProvider {
  constructor() {
    this.providerUrl = env.smsTransportUrl || '';
    if (env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber) {
      this.twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);
      this.twilioFromNumber = env.twilioFromNumber;
    }
  }

  async send(to, code) {
    const message = `Your verification code is ${code}. It expires soon.`;

    if (this.twilioClient && this.twilioFromNumber) {
      await this.twilioClient.messages.create({
        body: message,
        from: this.twilioFromNumber,
        to,
      });
      return;
    }

    if (this.providerUrl) {
      const url = new URL(this.providerUrl);
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to,
          code,
          message,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SMS provider request failed: ${response.status} ${errorText}`);
      }
      return;
    }

    if (!isProductionEnv()) {
      console.log(`SMS OTP for ${to}: ${code}`);
      return;
    }

    throw new Error('Mobile OTP service is currently unavailable.');
  }
}

const smsProvider = new SmsProvider();

async function createOTP(identifier, type, ttlSeconds = 300, meta = {}) {
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

async function resendOTP(identifier, type, ttlSeconds = 300, meta = {}) {
  return createOTP(identifier, type, ttlSeconds, meta);
}

async function verifyOTP(identifier, code, type) {
  const doc = await OTP.findOne({ identifier, code, type, used: false, expiresAt: { $gt: new Date() } });
  if (!doc) return null;
  doc.used = true;
  await doc.save();
  return doc;
}

async function sendOTP(identifier, type, code) {
  if (EMAIL_OTP_TYPES.includes(type)) {
    return sendOTPEmail(identifier, code);
  }
  if (MOBILE_OTP_TYPES.includes(type)) {
    return smsProvider.send(identifier, code);
  }
  throw new Error('Unsupported OTP type for delivery');
}

module.exports = { createOTP, verifyOTP, resendOTP, sendOTP };
