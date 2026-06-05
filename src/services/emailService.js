const nodemailer = require('nodemailer');
const { env } = require('../config/env');

const transporter = nodemailer.createTransport(
  env.emailTransportUrl
    ? { sendmail: false, ...Object.fromEntries(new URLSearchParams(env.emailTransportUrl)) }
    : { sendmail: true }
);

async function sendEmail({ to, subject, text, html }) {
  const message = {
    from: env.emailFrom,
    to,
    subject,
    text,
    html,
  };
  return transporter.sendMail(message);
}

async function sendOTPEmail(to, code) {
  const subject = 'Your verification code';
  const text = `Your verification code is ${code}. It expires shortly.`;
  return sendEmail({ to, subject, text });
}

module.exports = { sendEmail, sendOTPEmail };
