const authService = require('../services/../services/auth/authService');
const { consumePasswordResetToken } = require('../services/../services/auth/passwordResetService');
const UserModel = require('../models/User');

async function resetPassword(req, res, next) {
  try {
    const { resetToken, newPassword } = req.body;
    const tokenDoc = await consumePasswordResetToken(resetToken);
    if (!tokenDoc) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }
    const user = await UserModel.findById(tokenDoc.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.passwordHash = await authService.hashPassword(newPassword);
    user.emailVerified = true;
    user.refreshTokenHash = null;
    await user.save();
    await authService.invalidateAllSessions(user._id);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) { next(err); }
}

module.exports = { resetPassword };
