const LOGO_URL = 'https://ik.imagekit.io/fg2rlac5z/kiara-ai/kiara-logo/transparent-image.png';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function renderTransactionalEmail({
  preheader,
  title,
  greeting,
  paragraphs,
  details = [],
  buttonLabel,
  buttonUrl,
  footer = 'This is an automated message. If you need help, contact Kiara Support.',
  accentColor = '#0891b2',
}) {
  const safeTitle = escapeHtml(title);
  const safeGreeting = escapeHtml(greeting);
  const safePreheader = escapeHtml(preheader);
  const safeParagraphs = paragraphs.map((paragraph) => `<p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.7">${escapeHtml(paragraph)}</p>`).join('');
  const safeDetails = details.map(({ label, value }) => (
    `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px">${escapeHtml(label)}</td><td align="right" style="padding:8px 0;color:#111827;font-size:14px;font-weight:600">${escapeHtml(value)}</td></tr>`
  )).join('');
  const safeButtonLabel = buttonLabel ? escapeHtml(buttonLabel) : '';
  const safeButtonUrl = buttonUrl ? escapeHtml(buttonUrl) : '';
  const buttonHtml = safeButtonUrl
    ? `<p style="margin:28px 0;text-align:center"><a href="${safeButtonUrl}" style="display:inline-block;border-radius:8px;background:${accentColor};padding:13px 24px;color:#fff;font-size:15px;font-weight:700;text-decoration:none">${safeButtonLabel}</a></p><p style="margin:0 0 20px;color:#6b7280;font-size:12px;line-height:1.6;word-break:break-all">If the button does not open, copy this link into Kiara: ${safeButtonUrl}</p>`
    : '';
  const textDetails = details.length
    ? `\n\n${details.map(({ label, value }) => `${label}: ${value}`).join('\n')}`
    : '';
  const textButton = buttonUrl ? `\n\n${buttonLabel}: ${buttonUrl}` : '';
  const safeFooter = escapeHtml(footer);

  return {
    text: `${greeting}\n\n${paragraphs.join('\n\n')}${textDetails}${textButton}\n\n${footer}\n\nKiara AI`,
    html: `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title></head><body style="margin:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#111827"><span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;color:transparent">${safePreheader}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px;background:#f3f6fb"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden"><tr><td align="center" style="padding:32px 28px 20px"><img src="${LOGO_URL}" width="64" height="64" alt="Kiara AI" style="display:block;width:64px;height:64px;object-fit:contain"><p style="margin:12px 0 0;color:#111827;font-size:20px;font-weight:700">Kiara AI</p></td></tr><tr><td style="padding:8px 32px 30px"><h1 style="margin:0 0 20px;color:#111827;font-size:22px;line-height:1.35">${safeTitle}</h1><p style="margin:0 0 18px;color:#111827;font-size:15px;line-height:1.6">${safeGreeting}</p>${safeParagraphs}${safeDetails ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">${safeDetails}</table>` : ''}${buttonHtml}<p style="margin:20px 0 0;color:#6b7280;font-size:13px;line-height:1.6">${safeFooter}</p></td></tr><tr><td align="center" style="padding:18px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px">© Kiara AI · Secure account services</td></tr></table></td></tr></table></body></html>`,
  };
}

module.exports = { renderTransactionalEmail };
