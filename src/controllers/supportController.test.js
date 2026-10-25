'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateSupportRequest } = require('./supportController');

test('trims and accepts a valid support request', () => {
  assert.deepEqual(
    validateSupportRequest({ subject: '  Billing  ', message: '  I need help with my plan.  ' }),
    { valid: true, subject: 'Billing', message: 'I need help with my plan.' },
  );
});

test('accepts and preserves an optional session rating', () => {
  assert.deepEqual(
    validateSupportRequest({
      subject: '  Kiara session issue report ',
      message: 'The voice response stopped unexpectedly.',
      rating: 2,
    }),
    {
      valid: true,
      subject: 'Kiara session issue report',
      message: 'The voice response stopped unexpectedly.',
      rating: 2,
    },
  );
});

test('rejects support requests outside the subject and message limits', () => {
  assert.equal(validateSupportRequest({ subject: '', message: 'This message is long enough.' }).valid, false);
  assert.equal(validateSupportRequest({ subject: 'Help', message: 'short' }).valid, false);
  assert.equal(validateSupportRequest({ subject: 'x'.repeat(121), message: 'This message is long enough.' }).valid, false);
  assert.equal(validateSupportRequest({ subject: 'Help', message: 'x'.repeat(3001) }).valid, false);
});

test('rejects invalid ratings', () => {
  for (const rating of [0, 6, 2.5, '5']) {
    assert.equal(
      validateSupportRequest({ subject: 'Help', message: 'This message is long enough.', rating }).valid,
      false,
    );
  }
});
