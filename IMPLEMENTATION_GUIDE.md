# Authentication System V2 - Implementation Guide

## Overview
Production-ready authentication system redesigned for immediate user onboarding with deferred email verification.

## Quick Start

### 1. Install Dependencies
```bash
npm install bcryptjs jsonwebtoken mongoose
```

### 2. Environment Variables
```env
# JWT Configuration
JWT_ACCESS_SECRET=your-access-secret-key-min-32-chars
JWT_REFRESH_SECRET=your-refresh-secret-key-min-32-chars

# Email Configuration
EMAIL_USER=your-gmail@gmail.com
EMAIL_PASS=your-app-password-16-chars

# Node Environment
NODE_ENV=development  # or production
```

### 3. Database Migration
Add new fields to existing User collection:
```javascript
// Run this once to migrate existing users
db.users.updateMany(
  {},
  {
    $set: {
      isVerified: { $cond: ['$emailVerified', true, false] },
      verifiedAt: {
        $cond: [
          '$emailVerified',
          { $ifNull: ['$updatedAt', new Date()] },
          null
        ]
      },
      verificationMethod: {
        $cond: ['$emailVerified', 'registration_otp', null]
      }
    }
  }
)
```

---

## File Structure

```
src/
├── models/
│   ├── User.js (UPDATED: added isVerified, verifiedAt, verificationMethod)
│   ├── OTP.js (UPDATED: added security fields - hashed OTP, failed attempts, etc)
│   └── Session.js
├── services/
│   ├── authServiceV2.js (NEW: registration without OTP, login for unverified users)
│   ├── otpServiceV2.js (NEW: hashed OTPs, rate limiting, security)
│   └── tokenService.js (existing: JWT generation)
├── controllers/
│   ├── authControllerV2.js (NEW: registration, login, forgot-password, verify-otp endpoints)
│   └── (other existing controllers)
├── middleware/
│   ├── authValidation.js (NEW: request validation for auth endpoints)
│   ├── authMiddleware.js (existing: JWT verification)
│   └── (other existing middleware)
└── routes/
    └── auth.js (UPDATED: add V2 endpoints)
```

---

## API Routes Setup

### app.js or routes/auth.js

```javascript
const express = require('express');
const authControllerV2 = require('../controllers/authControllerV2');
const authValidation = require('../middleware/authValidation');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// ============= REGISTRATION =============
router.post(
  '/register',
  authValidation.validateRegisterRequest,
  authControllerV2.register
);

// ============= LOGIN =============
router.post(
  '/login',
  authValidation.validateLoginRequest,
  authControllerV2.login
);

// ============= FORGOT PASSWORD - STEP 1: REQUEST OTP =============
router.post(
  '/forgot-password',
  authValidation.validateForgotPasswordRequest,
  authControllerV2.forgotPassword
);

// ============= FORGOT PASSWORD - STEP 2: VERIFY OTP & RESET =============
router.post(
  '/verify-otp-and-reset',
  authValidation.validateOTPResetRequest,
  authControllerV2.verifyOTPAndResetPassword
);

// ============= VERIFICATION STATUS (protected) =============
router.get(
  '/verification-status',
  authMiddleware.verifyToken, // Requires valid JWT
  authControllerV2.getVerificationStatus
);

// ============= REFRESH TOKEN (protected) =============
router.post(
  '/refresh-token',
  authMiddleware.verifyToken,
  authControllerV2.refreshToken
);

// ============= LOGOUT (protected) =============
router.post(
  '/logout',
  authMiddleware.verifyToken,
  authControllerV2.logout
);

module.exports = router;
```

### Add to main app.js:

```javascript
const authRoutes = require('./routes/auth');

// ... other middleware ...

app.use('/api/auth', authRoutes);

// ... rest of app ...
```

---

## Complete Request/Response Examples

### 1. User Registration

**Request:**
```bash
POST /api/auth/register
Content-Type: application/json

{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@gmail.com",
  "password": "SecurePass123",
  "mobileNumber": "+1234567890"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Registration successful. You can login immediately.",
  "user": {
    "id": "507f1f77bcf86cd799439011",
    "email": "john@gmail.com",
    "firstName": "John",
    "lastName": "Doe",
    "displayName": "John Doe",
    "isVerified": false,
    "verifiedAt": null,
    "verificationMethod": null,
    "role": "user",
    "createdAt": "2024-01-15T10:30:00Z"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Response (400):**
```json
{
  "success": false,
  "message": "Only @gmail.com email addresses are allowed"
}
```

---

### 2. User Login

**Request:**
```bash
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@gmail.com",
  "password": "SecurePass123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Login successful.",
  "user": {
    "id": "507f1f77bcf86cd799439011",
    "email": "john@gmail.com",
    "firstName": "John",
    "isVerified": false,
    "verifiedAt": null,
    "verificationMethod": null
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Response (400):**
```json
{
  "success": false,
  "message": "Invalid email or password."
}
```

**Error Response (429 - Locked):**
```json
{
  "success": false,
  "message": "Account temporarily locked. Try again in 28 minutes."
}
```

---

### 3. Forgot Password - Request OTP

**Request:**
```bash
POST /api/auth/forgot-password
Content-Type: application/json

{
  "email": "john@gmail.com"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "OTP sent to your email if account exists"
}
```

Note: Returns same message regardless of whether email exists (account enumeration protection)

---

### 4. Forgot Password - Verify OTP & Reset Password

**Request:**
```bash
POST /api/auth/verify-otp-and-reset
Content-Type: application/json

{
  "email": "john@gmail.com",
  "otpCode": "123456",
  "newPassword": "NewSecurePass456"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Password reset successful. Your account is now verified. Please login with your new password.",
  "user": {
    "id": "507f1f77bcf86cd799439011",
    "email": "john@gmail.com",
    "firstName": "John",
    "isVerified": true,
    "verifiedAt": "2024-01-15T12:45:00Z",
    "verificationMethod": "password_reset_otp"
  },
  "verificationMethod": "password_reset_otp"
}
```

**Error Response (400 - Invalid OTP):**
```json
{
  "success": false,
  "message": "Invalid or expired OTP."
}
```

**Error Response (429 - Too Many Attempts):**
```json
{
  "success": false,
  "message": "Too many failed attempts. OTP locked for 30 minutes."
}
```

---

### 5. Check Verification Status

**Request:**
```bash
GET /api/auth/verification-status
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Response (200):**
```json
{
  "success": true,
  "isVerified": true,
  "verifiedAt": "2024-01-15T12:45:00Z",
  "verificationMethod": "password_reset_otp",
  "email": "john@gmail.com"
}
```

---

## Testing the System

### Postman Collection

```json
{
  "info": { "name": "Auth V2 API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "item": [
    {
      "name": "Register",
      "request": {
        "method": "POST",
        "url": "{{BASE_URL}}/api/auth/register",
        "body": {
          "mode": "raw",
          "raw": "{\"firstName\":\"John\",\"lastName\":\"Doe\",\"email\":\"john@gmail.com\",\"password\":\"Test1234\"}"
        }
      }
    },
    {
      "name": "Login",
      "request": {
        "method": "POST",
        "url": "{{BASE_URL}}/api/auth/login",
        "body": {
          "mode": "raw",
          "raw": "{\"email\":\"john@gmail.com\",\"password\":\"Test1234\"}"
        }
      }
    },
    {
      "name": "Forgot Password",
      "request": {
        "method": "POST",
        "url": "{{BASE_URL}}/api/auth/forgot-password",
        "body": {
          "mode": "raw",
          "raw": "{\"email\":\"john@gmail.com\"}"
        }
      }
    },
    {
      "name": "Verify OTP & Reset",
      "request": {
        "method": "POST",
        "url": "{{BASE_URL}}/api/auth/verify-otp-and-reset",
        "body": {
          "mode": "raw",
          "raw": "{\"email\":\"john@gmail.com\",\"otpCode\":\"123456\",\"newPassword\":\"NewPass1234\"}"
        }
      }
    }
  ]
}
```

---

## Security Checklist

- [x] Email validation: strict format, lowercase, trim, domain validation
- [x] Password hashing: bcrypt with 12 rounds
- [x] OTP hashing: bcrypt, never store plain
- [x] Rate limiting: 5 OTP creation per hour, 5 failed login attempts
- [x] Account lockout: 30 minutes after max failed attempts
- [x] Account enumeration protection: generic error messages
- [x] Failed attempt tracking: stored in database
- [x] OTP expiry: 10 minutes with TTL index
- [x] Token rotation: refresh tokens rotated on use
- [x] Session management: sessions deleted on logout
- [x] Auto-verification: first OTP success verifies account
- [x] httpOnly cookies: refresh token in secure cookie

---

## Deployment Checklist

- [ ] Set all environment variables securely
- [ ] Run database migration for existing users
- [ ] Test registration flow end-to-end
- [ ] Test login with unverified user
- [ ] Test forgot password with OTP
- [ ] Verify account auto-verification on OTP success
- [ ] Test rate limiting
- [ ] Test account lockout
- [ ] Test session management
- [ ] Monitor error logs
- [ ] Set up email alerts for suspicious activity
- [ ] Review CORS and CSRF settings
- [ ] Test on production environment

---

## Common Issues & Solutions

### Issue: OTP not sending
**Solution:** Check EMAIL_USER and EMAIL_PASS env vars, verify Gmail App Password is 16 chars

### Issue: Account gets locked
**Solution:** Failed attempts counter needs reset; user can use forgot-password to unlock

### Issue: User can't verify
**Solution:** Make sure OTP hasn't expired (10 min), check database for used OTP records

### Issue: Login fails for unverified user
**Solution:** In new flow, unverified users CAN login. If getting errors, check password is correct

---

## Migration from Old Auth System

### Step 1: Update Models
- Update User.js with new fields
- Update OTP.js with hashed fields

### Step 2: Database Migration
```javascript
// Add fields to existing users
db.users.updateMany({}, {
  $set: {
    isVerified: { $cond: ['$emailVerified', true, false] },
    verifiedAt: { $cond: ['$emailVerified', '$updatedAt', null] },
    verificationMethod: { $cond: ['$emailVerified', 'registration_otp', null] }
  }
})
```

### Step 3: Deploy New Services & Controllers
- Deploy authServiceV2, otpServiceV2, controllers, middleware

### Step 4: Update Routes
- Add new V2 routes to Express app
- Keep old endpoints running during transition (if needed)

### Step 5: Test
- Test with existing users (should work as before)
- Test with new registrations (no OTP required)
- Test forgot password with OTP

---

## Support & Troubleshooting

For issues, check:
1. Console logs - detailed error messages
2. Database records - check User, OTP, Session collections
3. Environment variables - all set correctly
4. Network - CORS, firewalls, SSL certificates

---

## Next Steps

1. Implement in your Express app
2. Test thoroughly
3. Deploy to staging
4. User acceptance testing
5. Deploy to production
6. Monitor metrics

---

**Last Updated:** 2024-01-15
**Version:** 2.0
