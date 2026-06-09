const nodemailer = require("nodemailer");
const { env } = require("../config/env");

const transporter = nodemailer.createTransport(
  env.emailTransportUrl
    ? env.emailTransportUrl
    : { sendmail: true }
);

async function sendEmail({ to, subject, text, html }) {
  const fromAddress = env.emailFrom.includes("<")
    ? env.emailFrom
    : `Kiara Security <${env.emailFrom}>`;

  const message = {
    from: fromAddress,
    to,
    replyTo: env.emailFrom,
    subject,
    text,
    html,
    headers: {
      "X-Mailer": "Kiara",
      "X-Priority": "3",
    },
  };

  return transporter.sendMail(message);
}

async function sendOTPEmail(to, code, userName = "User") {
  const subject = "Kiara: Your verification code";

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

module.exports = {
  sendEmail,
  sendOTPEmail,
};