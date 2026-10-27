'use strict';

const { hasAdminPanelAccess } = require('../../middleware/requireAdmin');

function isGoogleOAuthAccountAllowed({
  purpose = 'admin',
  emailAccount,
  googleIdMismatch = false,
  emailMismatch = false,
}) {
  if (googleIdMismatch || emailMismatch) {
    return false;
  }

  if (purpose === 'user') {
    return !emailAccount || (emailAccount.role === 'user' && emailAccount.isActive === true);
  }

  return hasAdminPanelAccess(emailAccount);
}

module.exports = { isGoogleOAuthAccountAllowed };
