const nodemailer = require('nodemailer');
const { env } = require('../config/env');

let transporter = null;

function formatErrorDetails(error) {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }

  return {
    code: error.code || null,
    command: error.command || null,
    response: error.response || null,
    responseCode: error.responseCode || null,
    message: error.message || null,
    stack: error.stack || null,
    // nodemailer sometimes carries nested response objects
    responseHeaders: error.responseHeaders || null,
  };
}

function getFromAddress() {
  const from = env.emailFrom ? env.emailFrom.trim() : env.smtpUser.trim();
  if (!from) {
    throw new Error('EMAIL_FROM or SMTP_USER must be configured.');
  }

  if (from.toLowerCase() !== env.smtpUser.trim().toLowerCase()) {
    console.warn(
      'EMAIL_FROM differs from SMTP_USER. Gmail may reject messages from a sender address that does not match the authenticated account. Using SMTP_USER as the from address for the transport.'
    );
    return env.smtpUser.trim();
  }

  return from;
}

function buildSmtpDiagnostics() {
  return {
    SMTP_HOST: Boolean(env.smtpHost),
    SMTP_PORT: env.smtpPort,
    SMTP_SECURE: env.smtpSecure,
    SMTP_USER: Boolean(env.smtpUser),
    SMTP_PASS_EXISTS: Boolean(env.smtpPass),
    SMTP_PASS_LENGTH: env.smtpPass ? env.smtpPass.length : 0,
    SMTP_PASS_APPPASSWORD: env.smtpPass ? env.smtpPass.length === 16 : false,
    EMAIL_FROM: Boolean(env.emailFrom),
    EMAIL_FROM_MATCHES_SMTP_USER:
      Boolean(env.emailFrom) && Boolean(env.smtpUser)
        ? env.emailFrom.trim().toLowerCase() === env.smtpUser.trim().toLowerCase()
        : false,
  };
}

function validateSmtpConfig() {
  const missingVars = [];
  if (!env.smtpHost) missingVars.push('SMTP_HOST');
  if (!env.smtpPort) missingVars.push('SMTP_PORT');
  if (!env.smtpUser) missingVars.push('SMTP_USER');
  if (!env.smtpPass) missingVars.push('SMTP_PASS');

  if (missingVars.length > 0) {
    const missing = missingVars.join(', ');
    const message = `SMTP configuration missing: ${missing}. Set these variables in your environment.`;
    console.error(message);
    throw new Error(message);
  }

  if (env.smtpPass.length !== 16) {
    console.warn(
      `SMTP_PASS appears to be ${env.smtpPass.length} characters long. Gmail App Passwords should be 16 characters.`
    );
  }
}

async function initEmailTransport() {
  validateSmtpConfig();
  console.log('SMTP config loaded:', buildSmtpDiagnostics());

  const transportConfig = {
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    requireTLS: true,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass,
    },
    authMethod: 'LOGIN',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    tls: {
      rejectUnauthorized: true,
    },
    logger: true,
    debug: true,
  };

  console.log(`Using explicit SMTP transport: ${env.smtpHost}:${env.smtpPort} secure=${env.smtpSecure}`);

  transporter = nodemailer.createTransport(transportConfig);

  try {
    const verifyResult = await transporter.verify();
    console.log('SMTP transport verified successfully.', { verifyResult });
    return { success: true, verifyResult };
  } catch (error) {
    const diagnostics = formatErrorDetails(error);
    console.error('SMTP transport verification failed:', diagnostics);
    throw error;
  }
}

function getTransporter() {
  if (!transporter) {
    throw new Error('Email transporter has not been initialized. Call initEmailTransport() before sending mail.');
  }
  return transporter;
}

async function sendEmail({ to, subject, text, html }) {
  const transport = getTransporter();
  const fromAddress = getFromAddress();

  const message = {
    from: fromAddress,
    to,
    replyTo: env.emailFrom || env.smtpUser,
    subject,
    text,
    html,
    headers: {
      'X-Mailer': 'Kiara',
      'X-Priority': '3',
    },
  };

  try {
    const info = await transport.sendMail(message);
    console.log('Nodemailer sendMail succeeded.', {
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      messageId: info.messageId,
    });
    return info;
  } catch (error) {
    const diagnostics = formatErrorDetails(error);
    console.error('Nodemailer sendMail failed:', diagnostics);

    if (diagnostics.code === 'EAUTH') {
      console.error('SMTP EAUTH error: authentication failed. Check SMTP_USER and SMTP_PASS.');
    }
    if (diagnostics.code === 'ETIMEDOUT') {
      console.error('SMTP ETIMEDOUT error: SMTP host connection timed out. Check network, DNS, and port blocking.');
    }
    if (diagnostics.code === 'ECONNECTION') {
      console.error('SMTP ECONNECTION error: could not connect to SMTP host. Check host, port, DNS, and network connectivity.');
    }

    throw error;
  }
}

async function sendOTPEmail(to, code, userName = 'User') {
  const subject = 'Kiara: Your verification code';

  const text = `Hello ${userName},

We received a request to verify your email address.

Your Kiara verification code is: ${code}

This code expires in 10 minutes.

For your security, never share this code with anyone.

If you did not request this, you can safely ignore this email.

Regards,
Kiara Team`;

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Email Verification</title>
</head>

<body style="
margin:0;
padding:0;
background:#f4f7fa;
font-family:Arial,Helvetica,sans-serif;
">

<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;background:#f4f7fa;">
<tr>
<td align="center">

<table width="600" cellpadding="0" cellspacing="0" style="
background:#ffffff;
border-radius:12px;
border:1px solid #e5e7eb;
overflow:hidden;
">

<tr>
<td align="center" style="padding:40px 30px 20px;">

<img
src="https://ik.imagekit.io/fg2rlac5z/kiara-ai/kiara-logo/transparent-image.png"
alt="Kiara"
width="80"
height="80"
style="border-radius:50%;display:block;"
>

<h1 style="
margin:20px 0 0;
font-size:28px;
color:#111827;
">
Kiara
</h1>

<p style="
margin-top:10px;
font-size:14px;
color:#6b7280;
">
Secure Account Verification
</p>

</td>
</tr>

<tr>
<td style="padding:20px 40px;">

<p style="
margin:0;
font-size:16px;
line-height:1.7;
color:#111827;
">
Hello ${userName},
</p>

<p style="
font-size:16px;
line-height:1.7;
color:#374151;
margin-top:20px;
">
We received a request to verify your email address.
Use the verification code below to continue securely.
</p>

</td>
</tr>

<tr>
<td align="center" style="padding:10px 40px 30px;">

<div style="
display:inline-block;
padding:18px 35px;
font-size:34px;
font-weight:700;
letter-spacing:8px;
background:#f9fafb;
border:1px solid #d1d5db;
border-radius:10px;
color:#111827;
">
${code}
</div>

</td>
</tr>

<tr>
<td style="padding:0 40px 30px;">

<p style="
font-size:15px;
line-height:1.8;
color:#4b5563;
">
This verification code will expire in
<strong>10 minutes</strong>.
</p>

<p style="
font-size:15px;
line-height:1.8;
color:#4b5563;
">
For your security, never share this code with anyone.
</p>

<p style="
font-size:15px;
line-height:1.8;
color:#4b5563;
">
If you did not request this verification, you can safely ignore this email.
</p>

</td>
</tr>

<tr>
<td style="
padding:25px 40px;
background:#f9fafb;
border-top:1px solid #e5e7eb;
">

<p style="
margin:0;
font-size:14px;
color:#6b7280;
">
Regards,
</p>

<p style="
margin-top:8px;
font-size:15px;
font-weight:600;
color:#111827;
">
Kiara Security Team
</p>

</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>
`;

  return sendEmail({
    to,
    subject,
    text,
    html,
  });
}

async function sendTestEmail(to) {
  const resolvedTo = to && typeof to === 'string' ? to.trim() : env.emailFrom || env.smtpUser;
  if (!resolvedTo) {
    throw new Error('Test email recipient is missing. Provide a `to` query parameter or set EMAIL_FROM/SMTP_USER.');
  }

  const subject = 'Kiara test email';
  const text = `This is a test message from Kiara. If you receive this email, SMTP is working correctly.`;
  const html = `<p>This is a test message from Kiara.</p><p>If you receive this email, SMTP is working correctly.</p>`;

  return sendEmail({
    to: resolvedTo,
    subject,
    text,
    html,
  });
}

function getEmailTransportDiagnostics() {
  return buildSmtpDiagnostics();
}

module.exports = {
  initEmailTransport,
  sendEmail,
  sendOTPEmail,
  sendTestEmail,
  formatErrorDetails,
  getEmailTransportDiagnostics,
};