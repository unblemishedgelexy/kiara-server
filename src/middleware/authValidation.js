/**
 * Request Validation Middleware for Auth V2
 * 
 * Validates:
 * - Email format (strict)
 * - Password strength
 * - Required fields
 * - Input sanitization
 */

const authServiceV2 = require('../services/../services/auth/authServiceV2');

// Validation middleware for registration
function validateRegisterRequest(req, res, next) {
  try {
    const { firstName, lastName, email, password, mobileNumber } = req.body;

    // Check required fields
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: firstName, lastName, email, password',
      });
    }

    // Trim and validate
    const trimmedFirstName = String(firstName).trim();
    const trimmedLastName = String(lastName).trim();
    const trimmedEmail = String(email).trim();
    const trimmedPassword = String(password);

    // Check lengths
    if (trimmedFirstName.length < 2 || trimmedFirstName.length > 50) {
      return res.status(400).json({
        success: false,
        message: 'First name must be between 2 and 50 characters',
      });
    }

    if (trimmedLastName.length < 2 || trimmedLastName.length > 50) {
      return res.status(400).json({
        success: false,
        message: 'Last name must be between 2 and 50 characters',
      });
    }

    // Validate email
    const emailValidation = authServiceV2.validateEmailFormat(trimmedEmail);
    if (!emailValidation.valid) {
      return res.status(400).json({
        success: false,
        message: emailValidation.error,
      });
    }

    // Validate password
    const passwordValidation = authServiceV2.validatePassword(trimmedPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.error,
      });
    }

    // Attach sanitized values to request
    req.validatedInput = {
      firstName: trimmedFirstName,
      lastName: trimmedLastName,
      email: emailValidation.normalizedEmail,
      password: trimmedPassword,
      mobileNumber: mobileNumber ? String(mobileNumber).trim() : undefined,
    };

    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Invalid request format.',
    });
  }
}

// Validation middleware for login
function validateLoginRequest(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
      });
    }

    const trimmedEmail = String(email).trim();
    const trimmedPassword = String(password);

    // Validate email format
    const emailValidation = authServiceV2.validateEmailFormat(trimmedEmail);
    if (!emailValidation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format.',
      });
    }

    req.validatedInput = {
      email: emailValidation.normalizedEmail,
      password: trimmedPassword,
    };

    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Invalid request format.',
    });
  }
}

// Validation middleware for forgot password
function validateForgotPasswordRequest(req, res, next) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required.',
      });
    }

    const trimmedEmail = String(email).trim();
    const emailValidation = authServiceV2.validateEmailFormat(trimmedEmail);
    
    // Don't reveal if email is valid (account enumeration protection)
    // Still validate format for clarity, but return generic message on error
    if (!emailValidation.valid) {
      // Return generic message
      return res.status(200).json({
        success: true,
        message: 'OTP sent to your email if account exists',
      });
    }

    req.validatedInput = {
      email: emailValidation.normalizedEmail,
    };

    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Invalid request format.',
    });
  }
}

// Validation middleware for OTP verification and password reset
function validateOTPResetRequest(req, res, next) {
  try {
    const { email, otpCode, newPassword } = req.body;

    if (!email || !otpCode || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, OTP code, and new password are required.',
      });
    }

    const trimmedEmail = String(email).trim();
    const trimmedOtpCode = String(otpCode).trim();
    const trimmedPassword = String(newPassword);

    // Validate email
    const emailValidation = authServiceV2.validateEmailFormat(trimmedEmail);
    if (!emailValidation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format.',
      });
    }

    // Validate OTP format (should be 6 digits)
    if (!/^\d{6}$/.test(trimmedOtpCode)) {
      return res.status(400).json({
        success: false,
        message: 'OTP must be 6 digits.',
      });
    }

    // Validate password
    const passwordValidation = authServiceV2.validatePassword(trimmedPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.error,
      });
    }

    req.validatedInput = {
      email: emailValidation.normalizedEmail,
      otpCode: trimmedOtpCode,
      newPassword: trimmedPassword,
    };

    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Invalid request format.',
    });
  }
}

// Validation middleware for requesting email verification OTP from profile
function validateRequestEmailVerificationOTP(req, res, next) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required.',
      });
    }

    const trimmedEmail = String(email).trim();
    const emailValidation = authServiceV2.validateEmailFormat(trimmedEmail);

    if (!emailValidation.valid) {
      return res.status(400).json({
        success: false,
        message: emailValidation.error,
      });
    }

    req.validatedInput = {
      email: emailValidation.normalizedEmail,
    };

    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Invalid request format.',
    });
  }
}

// Validation middleware for verifying email from profile
function validateVerifyEmailOTPRequest(req, res, next) {
  try {
    const { email, otpCode } = req.body;

    if (!email || !otpCode) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP code are required.',
      });
    }

    const trimmedEmail = String(email).trim();
    const trimmedOtpCode = String(otpCode).trim();

    // Validate email
    const emailValidation = authServiceV2.validateEmailFormat(trimmedEmail);
    if (!emailValidation.valid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format.',
      });
    }

    // Validate OTP format (should be 6 digits)
    if (!/^\d{6}$/.test(trimmedOtpCode)) {
      return res.status(400).json({
        success: false,
        message: 'OTP must be 6 digits.',
      });
    }

    req.validatedInput = {
      email: emailValidation.normalizedEmail,
      otpCode: trimmedOtpCode,
    };

    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Invalid request format.',
    });
  }
}

module.exports = {
  validateRegisterRequest,
  validateLoginRequest,
  validateForgotPasswordRequest,
  validateOTPResetRequest,
  validateRequestEmailVerificationOTP,
  validateVerifyEmailOTPRequest,
};
