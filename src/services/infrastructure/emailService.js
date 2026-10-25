const nodemailer = require('nodemailer');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { env } = require('../../config/env');
const { renderTransactionalEmail } = require('./transactionalEmailTemplate');

let transporter = null;
let sesClient = null;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function formatErrorDetails(error) {
  if (!error || typeof error !== 'object') return { name: 'EmailProviderError' };
  return {
    code: error.code || null,
    name: error.name || 'EmailProviderError',
  };
}

function getFromAddress() {
  const from = (env.awsSesFromEmail || env.emailFrom || env.emailUser || '').trim();
  if (!from) throw new Error('AWS_SES_FROM_EMAIL, EMAIL_FROM, or SMTP_USER must be configured.');
  return from;
}

async function initEmailTransport() {
  return { success: true, provider: env.emailProvider };
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      auth: {
        user: env.emailUser,
        pass: env.emailPass,
      },
    });
  }
  return transporter;
}

function getSesClient() {
  if (!env.awsRegion) {
    throw new Error('AWS_REGION must be configured when EMAIL_PROVIDER=ses.');
  }
  if (!sesClient) {
    sesClient = new SESv2Client({ region: env.awsRegion, maxAttempts: 1 });
  }
  return sesClient;
}

function createSesMessage({ to, subject, text, html }) {
  return {
    FromEmailAddress: getFromAddress(),
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {}),
          ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  };
}

async function sendViaSes({ to, subject, text, html }) {
  const command = new SendEmailCommand(createSesMessage({ to, subject, text, html }));

  try {
    return await getSesClient().send(command, { abortSignal: AbortSignal.timeout(10000) });
  } catch (error) {
    console.error('[EMAIL_PROVIDER_FAILURE]', 'ses', error?.name || error?.code || 'unknown');
    throw new Error('Email delivery failed.');
  }
}

async function sendViaBrevo({ to, subject, text, html }) {
  if (!BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY not configured');
  }

  const fromAddress = getFromAddress();

  try {
    const response = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify({
        to: [{ email: to }],
        sender: { email: fromAddress, name: 'Kiara' },
        subject,
        htmlContent: html || `<p>${escapeHtml(text)}</p>`,
        textContent: text,
        replyTo: { email: fromAddress },
        headers: {
          'X-Mailer': 'Kiara',
          'X-Priority': '3',
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Brevo API returned HTTP ${response.status}.`);
    }

    const data = await response.json();

    return {
      messageId: data.messageId,
      accepted: [to],
      rejected: [],
    };
  } catch (error) {
    console.error('[EMAIL_PROVIDER_FAILURE]', 'brevo', error?.name || error?.code || 'unknown');
    throw new Error('Email delivery failed.');
  }
}

async function sendTransactionalEmail({ to, subject, template }) {
  const message = renderTransactionalEmail(template);
  return sendEmail({ to, subject, text: message.text, html: message.html });
}

async function sendAccountDeletionCancelled({ email, userName }) {
  return sendTransactionalEmail({
    to: email,
    subject: 'Your Kiara AI account deletion was cancelled',
    template: {
      preheader: 'Your account and saved data remain available.',
      title: 'Deletion request cancelled',
      greeting: `Hello ${userName || 'there'},`,
      paragraphs: [
        'The scheduled deletion of your Kiara AI account has been cancelled.',
        'Your account and saved memories have not been deleted. You can continue using Kiara as usual.',
        'If you did not cancel this request, change your email password and contact Kiara Support.',
      ],
    },
  });
}

async function sendAccountDeletionComplete({ email, userName }) {
  return sendTransactionalEmail({
    to: email,
    subject: 'Your Kiara AI account deletion is complete',
    template: {
      preheader: 'Your account deletion request has been processed.',
      title: 'Account deletion completed',
      greeting: `Hello ${userName || 'there'},`,
      paragraphs: [
        'The scheduled deletion of your Kiara AI account and associated saved memories has been processed.',
        'Some transaction or security records may be retained where required by law or for legitimate security purposes.',
      ],
    },
  });
}

const generateOTP = () => {
  return String(require('node:crypto').randomInt(100000, 1000000));
};

async function sendEmail({ to, subject, text, html }) {
  if (env.emailProvider === 'discard') {
    return { messageId: 'development-discarded', accepted: [], rejected: [] };
  }
  if (env.emailProvider === 'ses') {
    return sendViaSes({ to, subject, text, html });
  }
  if (env.emailProvider === 'brevo') {
    return sendViaBrevo({ to, subject, text, html });
  }
  if (env.emailProvider === 'smtp') {
    try {
      return await getTransporter().sendMail({
        from: getFromAddress(),
        to,
        replyTo: env.emailFrom || env.emailUser,
        subject,
        text,
        html,
        headers: { 'X-Mailer': 'Kiara', 'X-Priority': '3' },
      });
    } catch (error) {
      console.error('[EMAIL_PROVIDER_FAILURE]', 'smtp', error?.name || error?.code || 'unknown');
      throw new Error('Email delivery failed.');
    }
  }
  throw new Error(`Unsupported EMAIL_PROVIDER: ${env.emailProvider}`);
}

async function sendOTPEmail(email, code = null, userName = 'User', purpose = '') {
  const plainOtp = String(code || generateOTP());
  const otp = escapeHtml(plainOtp);
  const plainUserName = String(userName || 'User');
  userName = escapeHtml(plainUserName);
  const plainPurpose = typeof purpose === 'string' && purpose.trim() ? purpose.trim() : 'your email address';
  const safePurpose = escapeHtml(plainPurpose);

  const subject = purpose ? `Kiara: Verify ${plainPurpose}` : 'Kiara: Your verification code';

  const text = `  Hello ${plainUserName},\n\nWe received a request to verify ${plainPurpose}.\n\nYour Kiara verification code is: ${plainOtp}\n\nThis code expires in 10 minutes.\n\nFor your security, never share this code with anyone.\n\nIf you did not request this, you can safely ignore this email.\n\nRegards,\nKiara Team`;

  const html = `\n<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n<title>Email Verification</title>\n</head>\n\n<body style="\nmargin:0;\npadding:0;\nbackground:#f4f7fa;\nfont-family:Arial,Helvetica,sans-serif;\n">\n\n<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;background:#f4f7fa;">\n<tr>\n<td align="center">\n\n<table width="600" cellpadding="0" cellspacing="0" style="\nbackground:#ffffff;\nborder-radius:12px;\nborder:1px solid #e5e7eb;\noverflow:hidden;\n">\n\n<tr>\n<td align="center" style="padding:40px 30px 20px;">\n\n<img\nsrc="https://ik.imagekit.io/fg2rlac5z/kiara-ai/kiara-logo/transparent-image.png"\nalt="Kiara"\nwidth="80"\nheight="80"\nstyle="border-radius:50%;display:block;"\n>\n\n<h1 style="\nmargin:20px 0 0;\nfont-size:28px;\ncolor:#111827;\n">\nKiara\n</h1>\n\n<p style="\nmargin-top:10px;\nfont-size:14px;\ncolor:#6b7280;\n">\nSecure Account Verification\n</p>\n\n</td>\n</tr>\n\n<tr>\n<td style="padding:20px 40px;">\n\n<p style="\nmargin:0;\nfont-size:16px;\nline-height:1.7;\ncolor:#111827;\n">\nHello ${userName},\n</p>\n\n<p style="\nfont-size:16px;\nline-height:1.7;\ncolor:#374151;\nmargin-top:20px;\n">\n  We received a request to verify ${safePurpose}.\nUse the verification code below to continue securely.\n</p>\n\n</td>\n</tr>\n\n<tr>\n<td align="center" style="padding:10px 40px 30px;">\n\n<div style="\ndisplay:inline-block;\npadding:18px 35px;\nfont-size:34px;\nfont-weight:700;\nletter-spacing:8px;\nbackground:#f9fafb;\nborder:1px solid #d1d5db;\nborder-radius:10px;\ncolor:#111827;\n">\n${otp}\n</div>\n\n</td>\n</tr>\n\n<tr>\n<td style="padding:0 40px 30px;">\n\n<p style="\nfont-size:15px;\nline-height:1.8;\ncolor:#4b5563;\n">\nThis verification code will expire in\n<strong>10 minutes</strong>.\n</p>\n\n<p style="\nfont-size:15px;\nline-height:1.8;\ncolor:#4b5563;\n">\nFor your security, never share this code with anyone.\n</p>\n\n<p style="\nfont-size:15px;\nline-height:1.8;\ncolor:#4b5563;\n">\nIf you did not request this verification, you can safely ignore this email.\n</p>\n\n</td>\n</tr>\n\n<tr>\n<td style="\npadding:25px 40px;\nbackground:#f9fafb;\nborder-top:1px solid #e5e7eb;\n">\n\n<p style="\nmargin:0;\nfont-size:14px;\ncolor:#6b7280;\n">\nRegards,\n</p>\n\n<p style="\nmargin-top:8px;\nfont-size:15px;\nfont-weight:600;\ncolor:#111827;\n">\nKiara Security Team\n</p>\n\n</td>\n</tr>\n\n</table>\n\n</td>\n</tr>\n</table>\n\n</body>\n</html>\n`;

  return sendEmail({ to: email, subject, text, html });
}

async function sendTestEmail(to) {
  const resolvedTo = to && typeof to === 'string' ? to.trim() : env.emailFrom || process.env.EMAIL_USER;
  if (!resolvedTo) {
    throw new Error('Test email recipient is missing. Provide a `to` query parameter or set EMAIL_FROM/EMAIL_USER.');
  }

  const subject = 'Kiara test email';
  const text = `This is a test message from Kiara. If you receive this email, SMTP connectivity is working.`;
  const html = `<p>This is a test message from Kiara.</p><p>If you receive this email, SMTP connectivity is working.</p>`;

  return sendEmail({
    to: resolvedTo,
    subject,
    text,
    html,
  });
}

async function sendDeleteNotification(email, message) {
  const plainMessage = String(message ?? '');
  const mailHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; padding: 20px; border: 1px solid #ddd; border-radius: 5px; max-width: 600px; margin: auto;">
      <h2 style="color: #d9534f;">Account Deletion Notification</h2>
      <p>Hello,</p>
      <p>This is to inform you that your account has been deleted by an administrator. The reason provided is:</p>
      <blockquote style="background-color: #f9f9f9; border-left: 5px solid #ccc; margin: 15px 0; padding: 10px 20px; font-style: italic;">
        <p style="margin: 0;">${escapeHtml(plainMessage)}</p>
      </blockquote>
      <p>If you believe this was a mistake or have any questions, please contact our support team.</p>
      <p>This is an automated message. Please do not reply.</p>
    </div>
  `;

  try {
    await sendEmail({
      to: email,
      subject: 'Account Deletion Notification',
      text: `Your account has been deleted. Reason: ${plainMessage}`,
      html: mailHtml,
    });

    return { success: true };
  } catch (error) {
    console.error('Email send failed:', error?.code || error?.name || 'EMAIL_PROVIDER_FAILURE');
    throw error;
  }
}

async function sendReportNotification(user, message) {
  const reportNumber = String(message?.reportNumber ?? '');
  const reportDetails = String(message?.reportDetails ?? '');
  const username = String(user?.username || 'User');
  const email = String(user?.email || '');
  const mailHtml = `        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; padding: 20px; border: 1px solid #ddd; border-radius: 5px; max-width: 600px; margin: auto;">
          <h2 style="color: #007bff;">Report Confirmation</h2>
          <p>Hello,</p>
          <p>This email is to confirm that your report has been successfully submitted. We appreciate you taking the time to report this issue.</p>
          <p>Here are the details of your report:</p>
          <ul>
            <li><strong>Report Number:</strong> ${escapeHtml(reportNumber)}</li>
            <li><strong>Reported By:</strong> ${escapeHtml(username)} (${escapeHtml(email)})</li>
            <li><strong>Report Details:</strong> ${escapeHtml(reportDetails)}</li>
          </ul>
          <p>Your report is currently awaiting approval. You will receive another email once it has been approved or resolved.</p>
          <p>Thank you for helping us maintain a safe and productive environment.</p>
          <p>This is an automated message. Please do not reply.</p>
        </div>
      `;

  try {
    await sendEmail({
      to: user.email,
      subject: 'Report Notification',
      text: `Report submitted: ${reportNumber}`,
      html: mailHtml,
    });

    return { success: true };
  } catch (error) {
    console.error('Email send failed:', error?.code || error?.name || 'EMAIL_PROVIDER_FAILURE');
    throw error;
  }
}

async function sendtemplateRejectedNotification(user, message) {
  const username = String(user?.name || 'there');
  const plainMessage = String(message ?? '');
  const mailHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 20px auto; border: 1px solid #ddd; border-radius: 10px; overflow: hidden;">
      <div style="background-color: #f8f8f8; padding: 20px; text-align: center;">
        <h1 style="color: #c0392b; margin: 0;">Template Submission Update</h1>
      </div>
      <div style="padding: 25px;">
        <p style="font-size: 16px;">Hi ${escapeHtml(username)},</p>
        <p style="font-size: 16px;">
          Thank you for submitting your template to our platform. Our team has reviewed your submission, and unfortunately, it did not meet our guidelines at this time.
        </p>
        <p style="font-size: 16px;">
          Here is the feedback from our review team:
        </p>
        <div style="background-color: #fff5f5; border-left: 4px solid #c0392b; padding: 15px; margin: 20px 0; font-style: italic;">
          <p style="margin: 0;">${escapeHtml(plainMessage)}</p>
        </div>
        <p style="font-size: 16px;">
          We encourage you to review this feedback and our submission guidelines. You are welcome to make adjustments and resubmit your template for another review.
        </p>
        <p style="font-size: 16px;">
          Thank you for your understanding and contribution.
        </p>
        <p style="font-size: 16px; margin-top: 30px;">
          Best regards,<br>
          The C.V. Forge Team
        </p>
      </div>
      <div style="background-color: #f8f8f8; padding: 15px; text-align: center; font-size: 12px; color: #777;">
        <p style="margin: 0;">&copy; ${new Date().getFullYear()} The Resume Builder. All rights reserved.</p>
      </div>
    </div>
  `;

  try {
    await sendEmail({
      to: user.email,
      subject: 'An Update on Your Template Submission',
      text: `Template submission update: ${plainMessage}`,
      html: mailHtml,
    });

    return { success: true };
  } catch (error) {
    console.error('Email send failed:', error?.code || error?.name || 'EMAIL_PROVIDER_FAILURE');
    throw error;
  }
}

module.exports = {
  initEmailTransport,
  sendEmail,
  sendTransactionalEmail,
  sendAccountDeletionCancelled,
  sendAccountDeletionComplete,
  sendOTPEmail,
  sendTestEmail,
  sendDeleteNotification,
  sendReportNotification,
  sendtemplateRejectedNotification,
  generateOTP,
  formatErrorDetails,
  getEmailTransportDiagnostics: () => ({ provider: env.emailProvider }),
  createSesMessage,
};
