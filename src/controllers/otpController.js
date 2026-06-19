const Joi = require('joi');
const { createOTP, verifyOTP, sendOTP, resendOTP } = require('../services/../services/auth/otpService');
const authService = require('../services/../services/auth/authService');
const pendingRegistrationService = require('../services/../services/auth/pendingRegistrationService');
const { createPasswordResetToken } = require('../services/../services/auth/passwordResetService');
const { OTP_TYPES, REGISTER_OTP_TYPES, FORGOT_PASSWORD_OTP_TYPES, CHANGE_OTP_TYPES, isEmailOtpType } = require('../config/otpTypes');
const { env, isProductionEnv } = require('../config/env');

function buildAuthPayload(user, accessToken, refreshToken) {
  const safeUser = authService.sanitizeUser(user);
  return {
    accessToken,
    refreshToken,
    token: accessToken,
    user: safeUser,
    data: { accessToken, refreshToken, user: safeUser },
  };
}


async function sendOtp(req, res, next) {
  try {
    const { type, email, mobileNumber, firstName, lastName, password, pendingRegistrationId } = req.body;

    if (!Object.values(OTP_TYPES).includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid OTP type.' });
    }

    if (type === OTP_TYPES.REGISTER_EMAIL || type === OTP_TYPES.REGISTER_MOBILE) {
      if (!firstName || !lastName || !email || !mobileNumber || !password) {
        return res.status(400).json({ success: false, message: 'Registration data is required for registration OTPs.' });
      }

      const existingEmailUser = await authService.findUserByEmail(email);
      if (existingEmailUser) {
        return res.status(400).json({ success: false, message: 'Email already in use.' });
      }
      const existingMobileUser = await authService.findUserByMobile(mobileNumber);
      if (existingMobileUser) {
        return res.status(400).json({ success: false, message: 'Mobile number already in use.' });
      }

      let pendingRegistration;
      if (pendingRegistrationId) {
        pendingRegistration = await pendingRegistrationService.findPendingRegistrationById(pendingRegistrationId);
        if (!pendingRegistration) {
          return res.status(404).json({ success: false, message: 'Pending registration not found.' });
        }
      } else {
        const passwordHash = await authService.hashPassword(password);
        pendingRegistration = await pendingRegistrationService.createPendingRegistration({
          firstName,
          lastName,
          email,
          mobileNumber,
          passwordHash,
        });
      }

      const targetType = type;
      const identifier = isEmailOtpType(type) ? email.toLowerCase() : mobileNumber;
      const otp = await createOTP(identifier, targetType, 300, { pendingRegistrationId: pendingRegistration._id });
      await sendOTP(identifier, targetType, otp.code);

      return res.status(200).json({
        success: true,
        message: 'OTP sent successfully',
        data: { pendingRegistrationId: pendingRegistration._id },
      });
    }

    if (FORGOT_PASSWORD_OTP_TYPES.includes(type)) {
      const identifier = isEmailOtpType(type) ? email : mobileNumber;
      if (!identifier) {
        return res.status(400).json({ success: false, message: 'Identifier is required for forgot password OTPs.' });
      }

      const user = isEmailOtpType(type)
        ? await authService.findUserByEmail(identifier)
        : await authService.findUserByMobile(identifier);

      if (!user) {
        return res.status(404).json({ success: false, message: 'No user found for the provided identifier.' });
      }

      const otp = await createOTP(identifier, type, 600, { userId: user._id });
      await sendOTP(identifier, type, otp.code);
      return res.json({ success: true, message: 'OTP sent successfully' });
    }

    if (CHANGE_OTP_TYPES.includes(type)) {
      if (!req.userId) {
        return res.status(401).json({ success: false, message: 'Authentication required to change contact information.' });
      }
      const identifier = isEmailOtpType(type) ? email : mobileNumber;
      if (!identifier) {
        return res.status(400).json({ success: false, message: 'Identifier is required for contact change OTPs.' });
      }

      const existing = isEmailOtpType(type)
        ? await authService.findUserByEmail(identifier)
        : await authService.findUserByMobile(identifier);
      if (existing && String(existing._id) !== String(req.userId)) {
        return res.status(400).json({ success: false, message: 'Identifier already in use.' });
      }

      const otp = await createOTP(identifier, type, 300, { userId: req.userId });
      await sendOTP(identifier, type, otp.code);
      return res.json({ success: true, message: 'OTP sent successfully' });
    }

    return res.status(400).json({ success: false, message: 'OTP type not supported.' });
  } catch (err) {
    next(err);
  }
}

async function verifyOtp(req, res, next) {
  try {
    const { type, email, mobileNumber, code, pendingRegistrationId } = req.body;

    if (!Object.values(OTP_TYPES).includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid OTP type.' });
    }

    const identifier = isEmailOtpType(type)
      ? email?.toLowerCase()
      : mobileNumber;

    if (!identifier || !code) {
      return res.status(400).json({ success: false, message: 'Identifier and code are required.' });
    }

    const otpDoc = await verifyOTP(identifier, code, type);
    if (!otpDoc) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }

    if (REGISTER_OTP_TYPES.includes(type)) {
      const pendingId = pendingRegistrationId || otpDoc.meta?.pendingRegistrationId;
      if (!pendingId) {
        return res.status(400).json({ success: false, message: 'Missing pending registration context.' });
      }
      const pendingRegistration = await pendingRegistrationService.findPendingRegistrationById(pendingId);
      if (!pendingRegistration) {
        return res.status(404).json({ success: false, message: 'Pending registration not found.' });
      }

      if (type === OTP_TYPES.REGISTER_EMAIL) {
        await pendingRegistrationService.markPendingRegistrationEmailVerified(pendingId);
      } else {
        await pendingRegistrationService.markPendingRegistrationMobileVerified(pendingId);
      }

      const updatedRegistration = await pendingRegistrationService.findPendingRegistrationById(pendingId);
      if (updatedRegistration.emailVerified && updatedRegistration.mobileVerified) {
        const user = await authService.createUser({
          firstName: updatedRegistration.firstName,
          lastName: updatedRegistration.lastName,
          email: updatedRegistration.email,
          mobileNumber: updatedRegistration.mobileNumber,
          passwordHash: updatedRegistration.passwordHash,
          mode: 'registered',
        });
        user.emailVerified = true;
        user.mobileVerified = true;
        await user.save();
        await pendingRegistrationService.completePendingRegistration(pendingId);

        const { accessToken, refreshToken } = await authService.createLoginSession(user._id);
        return res.status(201).json({
          success: true,
          message: 'Registration completed.',
          ...buildAuthPayload(user, accessToken, refreshToken),
        });
      }

      return res.json({ success: true, message: 'OTP verified. Continue with remaining registration verification.', data: { pendingRegistrationId: pendingId } });
    }

    if (FORGOT_PASSWORD_OTP_TYPES.includes(type)) {
      const otpUserId = otpDoc.meta?.userId;
      if (!otpUserId) {
        return res.status(400).json({ success: false, message: 'Invalid OTP metadata.' });
      }
      const resetToken = await createPasswordResetToken(otpUserId);
      return res.json({ success: true, message: 'OTP verified successfully.', data: { resetToken } });
    }

    if (CHANGE_OTP_TYPES.includes(type)) {
      if (!req.userId) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }
      const user = await authService.findUserById(req.userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
      }

      if (type === OTP_TYPES.CHANGE_EMAIL) {
        user.email = identifier;
        user.emailVerified = true;
      } else {
        user.mobileNumber = identifier;
        user.mobileVerified = true;
      }
      await user.save();
      return res.json({ success: true, message: 'Contact information updated successfully.', data: { user: authService.sanitizeUser(user) } });
    }

    return res.status(400).json({ success: false, message: 'OTP verification type not supported.' });
  } catch (err) {
    next(err);
  }
}

async function resendOtp(req, res, next) {
  try {
    const { type, email, mobileNumber, pendingRegistrationId } = req.body;

    if (!Object.values(OTP_TYPES).includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid OTP type.' });
    }

    const identifier = isEmailOtpType(type)
      ? email?.toLowerCase()
      : mobileNumber;

    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Identifier is required.' });
    }

    if (REGISTER_OTP_TYPES.includes(type)) {
      const pendingId = pendingRegistrationId;
      if (!pendingId) {
        return res.status(400).json({ success: false, message: 'Pending registration context is required.' });
      }
      const pendingRegistration = await pendingRegistrationService.findPendingRegistrationById(pendingId);
      if (!pendingRegistration) {
        return res.status(404).json({ success: false, message: 'Pending registration not found.' });
      }
      const otp = await resendOTP(identifier, type, 300, { pendingRegistrationId: pendingId });
      await sendOTP(identifier, type, otp.code);
      return res.json({ success: true, message: 'OTP resent successfully' });
    }

    if (FORGOT_PASSWORD_OTP_TYPES.includes(type)) {
      const user = isEmailOtpType(type)
        ? await authService.findUserByEmail(identifier)
        : await authService.findUserByMobile(identifier);
      if (!user) {
        return res.status(404).json({ success: false, message: 'No user found for the provided identifier.' });
      }
      const otp = await resendOTP(identifier, type, 600, { userId: user._id });
      await sendOTP(identifier, type, otp.code);
      return res.json({ success: true, message: 'OTP resent successfully' });
    }

    if (CHANGE_OTP_TYPES.includes(type)) {
      if (!req.userId) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }
      const otp = await resendOTP(identifier, type, 300, { userId: req.userId });
      await sendOTP(identifier, type, otp.code);
      return res.json({ success: true, message: 'OTP resent successfully' });
    }

    return res.status(400).json({ success: false, message: 'OTP resend type not supported.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { sendOtp, verifyOtp, resendOtp };
