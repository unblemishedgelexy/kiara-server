const crypto = require('node:crypto');
const Admin = require('../models/Admin');
const authService = require('../services/auth/authService');
const { generateAccessToken } = require('../services/auth/tokenService');
const { env } = require('../config/env');

function isRegistrationKeyValid(suppliedKey) {
  if (!env.adminRegistrationKey || typeof suppliedKey !== 'string') return false;
  const expected = Buffer.from(env.adminRegistrationKey);
  const supplied = Buffer.from(suppliedKey);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function hasAdminPasswordAccess(admin) {
  return Boolean(
    admin
    && admin.isActive
    && admin.emailVerified
    && ['admin', 'dev'].includes(admin.role)
    && admin.passwordHash,
  );
}

async function register(req, res, next) {
  const { firstName, lastName, email, password } = req.validated.body;
  try {
    if (!env.adminRegistrationKey) {
      return res.status(503).json({
        success: false,
        message: 'Admin registration is disabled until ADMIN_REGISTRATION_KEY is configured on the server.',
      });
    }
    if (!isRegistrationKeyValid(req.get('x-admin-registration-key'))) {
      return res.status(401).json({ success: false, message: 'Invalid admin registration key.' });
    }

    if (await Admin.countDocuments({}) === 0) {
      return res.status(403).json({
        success: false,
        message: 'First-admin bootstrap is disabled. Provision the initial admin through a controlled server-side process.',
      });
    }

    const existing = await Admin.findOne({ email });
    if (existing) {
      return res.status(409).json({ success: false, message: 'An admin account with this email already exists.' });
    }

    const adminData = {
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`.trim(),
      email: email.toLowerCase(),
      passwordHash: await authService.hashPassword(password),
      emailVerified: true,
      role: 'admin',
      isActive: true,
    };
    const admin = await Admin.create(adminData);
    return res.status(201).json({
      success: true,
      message: 'Admin account created. You can now sign in to the admin panel.',
      data: {
        user: {
          id: admin.id,
          firstName: admin.firstName,
          lastName: admin.lastName,
          email: admin.email,
          role: admin.role,
        },
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An admin account with this email already exists.',
      });
    }
    return next(error);
  }
}

async function login(req, res, next) {
  const { email, password } = req.validated.body;
  try {
    const admin = await Admin.findOne({ email }).select('+passwordHash');
    if (!hasAdminPasswordAccess(admin)) {
      return res.status(401).json({ success: false, message: 'Invalid admin email or password.' });
    }
    if (admin.loginLockedUntil && admin.loginLockedUntil > new Date()) {
      return res.status(429).json({ success: false, message: 'Sign-in is temporarily locked. Try again later.' });
    }

    const passwordValid = await authService.comparePassword(password, admin.passwordHash);
    if (!passwordValid) {
      admin.failedLoginAttempts = (admin.failedLoginAttempts || 0) + 1;
      if (admin.failedLoginAttempts >= 5) {
        admin.loginLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }
      await admin.save();
      return res.status(401).json({ success: false, message: 'Invalid admin email or password.' });
    }

    admin.failedLoginAttempts = 0;
    admin.loginLockedUntil = null;
    admin.lastLogin = new Date();
    await admin.save();

    const accessToken = generateAccessToken({ sub: admin._id, tokenType: 'admin' });

    return res.json({
      success: true,
      message: 'Admin signed in successfully.',
      data: {
        accessToken,
        user: {
          id: admin.id,
          firstName: admin.firstName,
          lastName: admin.lastName,
          email: admin.email,
          role: admin.role,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  register,
  login,
  isRegistrationKeyValid,
  hasAdminPasswordAccess,
};
