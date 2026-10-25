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

test('rejects support requests outside the subject and message limits', () => {
  assert.equal(validateSupportRequest({ subject: '', message: 'This message is long enough.' }).valid, false);
  assert.equal(validateSupportRequest({ subject: 'Help', message: 'short' }).valid, false);
  assert.equal(validateSupportRequest({ subject: 'x'.repeat(121), message: 'This message is long enough.' }).valid, false);
  assert.equal(validateSupportRequest({ subject: 'Help', message: 'x'.repeat(3001) }).valid, false);
});
