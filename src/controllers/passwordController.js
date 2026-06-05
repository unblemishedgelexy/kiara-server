const crypto = require('crypto');
const authService = require('../services/authService');
const { createOTP, verifyOTP, sendEmailOTP } = require('../services/otpService');
const { createPasswordResetToken, verifyPasswordResetToken, consumePasswordResetToken } = require('../services/passwordResetService');
const UserModel = require('../models/User');

async function requestPasswordReset(req, res, next) {
  try {
    const { email, mobileNumber } = req.body;
    const user = await UserModel.findOne({ email: email.toLowerCase(), mobileNumber });
    if (!user) {
      return res.status(400).json({ success: false, message: 'User not found for provided email and mobile number' });
    }
    const otp = await createOTP(user.email, 'forgot_password', 600, { userId: user._id });
    await sendEmailOTP(user.email, otp.code);
    res.json({ success: true, message: 'Password reset code sent to email' });
  } catch (err) { next(err); }
}

async function verifyForgotPasswordOTP(req, res, next) {
  try {
    const { email, code } = req.body;
    const doc = await verifyOTP(email.toLowerCase(), code, 'forgot_password');
    if (!doc) return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    const resetToken = await createPasswordResetToken(doc.meta.userId);
    res.json({ success: true, data: { resetToken } });
  } catch (err) { next(err); }
}

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

module.exports = { requestPasswordReset, verifyForgotPasswordOTP, resetPassword };
