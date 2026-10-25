const assert = require('node:assert/strict');
const test = require('node:test');
const { renderTransactionalEmail } = require('./transactionalEmailTemplate');

test('renders branded HTML and text while escaping user-controlled content', () => {
  const message = renderTransactionalEmail({
    preheader: 'Account update',
    title: '<Delete account>',
    greeting: 'Hello <script>',
    paragraphs: ['Review your & account.'],
    details: [{ label: 'Email', value: 'user@example.com' }],
    buttonLabel: 'Open Kiara',
    buttonUrl: 'com.kiara.ai://auth-complete?token=abc&flow=delete',
  });

  assert.match(message.html, /Kiara AI/);
  assert.match(message.html, /&lt;Delete account&gt;/);
  assert.match(message.html, /Hello &lt;script&gt;/);
  assert.match(message.html, /Review your &amp; account\./);
  assert.match(message.html, /kiara-logo/);
  assert.match(message.html, /token=abc&amp;flow=delete/);
  assert.match(message.text, /Open Kiara: com\.kiara\.ai:\/\/auth-complete/);
});
