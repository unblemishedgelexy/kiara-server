const { sendTestEmail, getEmailTransportDiagnostics, formatErrorDetails } = require('../services/../services/infrastructure/emailService');

async function testEmail(req, res) {
  const to = typeof req.query?.to === 'string' ? req.query.to.trim() : null;

  try {
    const response = await sendTestEmail(to);
    return res.json({
      success: true,
      message: 'Test email sent successfully.',
      to: to || null,
      transport: getEmailTransportDiagnostics(),
      nodemailerResponse: {
        accepted: response.accepted,
        rejected: response.rejected,
        response: response.response,
        responseCode: response.responseCode || null,
        messageId: response.messageId,
      },
    });
  } catch (error) {
    const details = formatErrorDetails(error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send test email.',
      error: details,
      transport: getEmailTransportDiagnostics(),
    });
  }
}

module.exports = {
  testEmail,
};