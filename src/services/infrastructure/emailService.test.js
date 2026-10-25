const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.EMAIL_PROVIDER = 'discard';
process.env.AWS_SES_FROM_EMAIL = 'sender@example.test';

const { createSesMessage, sendEmail } = require('./emailService');

test('SES message contains only the configured sender and requested message data', () => {
  assert.deepEqual(createSesMessage({
    to: 'recipient@example.test',
    subject: 'Verification',
    text: 'Your code is 123456',
    html: '<p>Your code is 123456</p>',
  }), {
    FromEmailAddress: 'sender@example.test',
    Destination: { ToAddresses: ['recipient@example.test'] },
    Content: {
      Simple: {
        Subject: { Data: 'Verification', Charset: 'UTF-8' },
        Body: {
          Text: { Data: 'Your code is 123456', Charset: 'UTF-8' },
          Html: { Data: '<p>Your code is 123456</p>', Charset: 'UTF-8' },
        },
      },
    },
  });
});

test('development email provider discards without contacting a delivery service', async () => {
  const result = await sendEmail({
    to: 'recipient@example.test',
    subject: 'Test',
    text: 'Not delivered',
  });
  assert.equal(result.messageId, 'development-discarded');
  assert.deepEqual(result.accepted, []);
});
