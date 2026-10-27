'use strict';

function isGoogleOAuthAccountAllowed({
  purpose = 'user',
  emailAccount,
  googleIdMismatch = false,
  emailMismatch = false,
}) {
  if (googleIdMismatch || emailMismatch) {
    return false;
  }

  return purpose === 'user'
    && (!emailAccount || (emailAccount.role === 'user' && emailAccount.isActive === true));
}

module.exports = { isGoogleOAuthAccountAllowed };
