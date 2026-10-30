'use strict';

function getGoogleOAuthAccountDenialReason({
  purpose = 'user',
  emailAccount,
  googleIdMismatch = false,
  emailMismatch = false,
}) {
  if (purpose !== 'user') {
    return 'unsupported_purpose';
  }

  if (googleIdMismatch || emailMismatch) {
    return 'identity_mismatch';
  }

  if (emailAccount && emailAccount.role !== 'user') {
    return 'admin_account';
  }

  return null;
}

function isGoogleOAuthAccountAllowed(options) {
  return getGoogleOAuthAccountDenialReason(options) === null;
}

module.exports = {
  getGoogleOAuthAccountDenialReason,
  isGoogleOAuthAccountAllowed,
};
