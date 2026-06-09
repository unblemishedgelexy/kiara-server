const authService = require('../services/authService');
const { verifyPasswordResetToken, consumePasswordResetToken } = require('../services/passwordResetService');
const UserModel = require('../models/User');

async function resetPassword(req, res, next) {
  try {
    const { resetToken, newPassword } = req.body;
    const tokenDoc = await verifyPasswordResetToken(resetToken);
    if (!tokenDoc) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }
    const user = await UserModel.findById(tokenDoc.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.passwordHash = await authService.hashPassword(newPassword);
    user.refreshTokenHash = null;
    await user.save();
    await authService.invalidateAllSessions(user._id);
    await consumePasswordResetToken(tokenDoc);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) { next(err); }
}

module.exports = { resetPassword };

