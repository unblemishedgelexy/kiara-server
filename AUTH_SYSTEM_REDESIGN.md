# Authentication System Architecture - Redesigned Flow

## Overview
Redesigned authentication system for startup that prioritizes immediate user onboarding while maintaining account verification through optional email confirmation.

## Key Principles

1. **Immediate Registration**: Users register with email/password and can login immediately
2. **Optional Verification**: Email verification happens later via forgot-password flow
3. **OTP-Triggered Verification**: First successful OTP verification (password reset) marks account as verified
4. **Security-First**: Hashed OTPs, rate limiting, failed attempt tracking, account enumeration protection
5. **Backward Compatible**: Existing accounts continue to work

---

## Data Model Changes

### User Schema (Updated)

```javascript
{
  // Identity
  firstName, lastName, displayName,
  email (unique, lowercase, required),
  passwordHash,
  
  // NEW: Verification tracking
  isVerified: Boolean (default: false),
  verifiedAt: Date (null until verified),
  verificationMethod: String (enum: 'registration_otp', 'password_reset_otp', 'oauth', 'admin'),
  
  // OAuth support
  googleId, googleEmail,
  
  // Optional
  mobileNumber, mobileVerified, profilePicture,
  
  // Security
  role, mode, isActive, twoFactorEnabled,
  lastLogin, failedLoginAttempts, loginLockedUntil,
  failedOtpAttempts, otpLockedUntil,
  
  // Tokens
  refreshTokenHash,
  
  timestamps: {createdAt, updatedAt}
}
```

### OTP Schema (Enhanced)

```javascript
{
  identifier: String (email/phone, indexed),
  codeHash: String (bcrypt hashed, never store plain),
  type: String (enum: FORGOT_PASSWORD_EMAIL, CHANGE_EMAIL, etc),
  used: Boolean (default: false),
  usedAt: Date,
  expiresAt: Date (auto-deletes via TTL index),
  
  // Security
  failedAttempts: Number (default: 0),
  maxAttempts: Number (default: 5),
  lockedUntil: Date (lockout after max attempts),
  
  // Tracking
  ipAddress, userAgent,
  meta: Mixed,
  
  timestamps: {createdAt, updatedAt}
}
```

---

## Authentication Flows

### Flow 1: User Registration (NO OTP REQUIRED)

```
User submits: email, password, firstName, lastName
                    ↓
        Validate email format strictly
        - Must be valid email format
        - lowercase normalize
        - trim whitespace
        - Gmail validation
                    ↓
        Check email not already registered
                    ↓
        Hash password (bcrypt)
                    ↓
        Create User with:
        - isVerified: false
        - verifiedAt: null
        - verificationMethod: null
                    ↓
        Return User + Access/Refresh tokens
        
User can immediately login & use app features
```

### Flow 2: User Login (Allows Unverified Users)

```
User submits: email, password
                    ↓
        Validate email format
                    ↓
        Find user by email
                    ↓
        Check if account locked (failed login attempts)
                    ↓
        Verify password
                    ↓
        Reset failed attempts counter
                    ↓
        Generate Access + Refresh tokens
                    ↓
        Return tokens + user data
        
Note: User is logged in regardless of isVerified status
```

### Flow 3: Forgot Password (WITH OTP VERIFICATION)

**Step 1: Request Password Reset**
```
User submits: email
                    ↓
        Validate email format
                    ↓
        Check if email exists
        (Account enumeration protection: 
         Return same message for existing/non-existing)
                    ↓
        Generate OTP code (6 digits, random)
        Hash OTP with bcrypt
        Store OTP with:
        - expiresAt: now + 10 minutes
        - failedAttempts: 0
        - lockedUntil: null
                    ↓
        Send OTP to email
                    ↓
        Return: "OTP sent if account exists"
```

**Step 2: Verify OTP Code**
```
User submits: email, otpCode, newPassword
                    ↓
        Find OTP record for email
        (Account enumeration: generic error if not found)
                    ↓
        Check if OTP expired
                    ↓
        Check if OTP already used
                    ↓
        Check if OTP locked (too many failed attempts)
                    ↓
        Compare user-provided code with stored hash
                    ↓
        If incorrect:
        - Increment failedAttempts
        - If failedAttempts >= 5:
          Lock OTP for 30 minutes
          Return generic error
                    ↓
        If correct:
        - Mark OTP as used
        - Hash new password
        - Update user password
        - AUTO-VERIFY: Set isVerified = true
        - Set verifiedAt = now
        - Set verificationMethod = 'password_reset_otp'
        - Clear session/refresh tokens (force re-login)
                    ↓
        Return: "Password reset successful"
```

---

## Security Implementation

### 1. Email Validation
```javascript
// Strict RFC 5322 compliant validation
- Must contain exactly one @
- Must have local part (before @)
- Must have domain (after @)
- No spaces anywhere
- Normalize to lowercase
- Trim whitespace
- Gmail validation:
  ✅ test@gmail.com
  ✅ abc123@gmail.com
  ❌ test@gmail (missing TLD)
  ❌ test@ gmail.com (space)
  ❌ testgmail.com (missing @)
  ❌ business email domains rejected
```

### 2. Password Security
```javascript
- Minimum 8 characters
- Hash with bcrypt (rounds: 12)
- Never store plain password
- Compare against hash during login
```

### 3. OTP Security
```javascript
- Generate random 6-digit code
- Hash with bcrypt (rounds: 10)
- Store only codeHash in database
- TTL: 10 minutes (auto-delete via MongoDB TTL index)
- Failed attempt tracking:
  * Max 5 attempts per OTP
  * Lock for 30 minutes after max attempts
  * Reset counter on success
- Rate limiting:
  * Max 5 OTP creation requests per hour per identifier
  * Enforce cooldown between requests
```

### 4. Account Lockout
```javascript
Failed login attempts:
- Track: failedLoginAttempts counter
- Lock after: 5 failed attempts
- Lockout duration: 30 minutes (loginLockedUntil)
- Reset counter: On successful login
- Message: Generic "Invalid email or password"

Failed OTP attempts:
- Track: failedAttempts per OTP record
- Lock after: 5 failed attempts
- Lockout duration: 30 minutes (otpLockedUntil on OTP doc)
- Message: Generic error (account enumeration protection)
```

### 5. Account Enumeration Protection
```javascript
- Failed password reset request:
  Always return: "OTP sent if account exists"
  Don't reveal if email is registered
- OTP verification failure:
  Always return: "Invalid or expired OTP"
  Don't reveal why (timeout, wrong code, etc)
```

### 6. Token Management
```javascript
Access Token:
- JWT, short-lived (15 minutes)
- Contains: sub (userId)
- Signed with JWT_ACCESS_SECRET

Refresh Token:
- JWT, long-lived (30 days)
- Hash stored in database
- Cannot be leaked via XSS
- Rotated on use
- Stored in httpOnly cookie (backend recommendation)
```

---

## API Endpoints

### 1. Registration
```
POST /api/auth/register
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@gmail.com",
  "password": "SecurePass123",
  "mobileNumber": "+1234567890" (optional)
}

Response 201:
{
  "success": true,
  "message": "Registration successful. You can login immediately.",
  "user": {
    "id": "user_id",
    "email": "john@gmail.com",
    "firstName": "John",
    "lastName": "Doe",
    "isVerified": false,
    "verifiedAt": null
  },
  "accessToken": "jwt_token",
  "refreshToken": "jwt_token"
}
```

### 2. Login
```
POST /api/auth/login
{
  "email": "john@gmail.com",
  "password": "SecurePass123"
}

Response 200:
{
  "success": true,
  "user": {...},
  "accessToken": "jwt_token",
  "refreshToken": "jwt_token"
}
```

### 3. Forgot Password - Request OTP
```
POST /api/auth/forgot-password
{
  "email": "john@gmail.com"
}

Response 200:
{
  "success": true,
  "message": "OTP sent to your email if account exists"
}
```

### 4. Forgot Password - Verify OTP & Reset
```
POST /api/auth/verify-otp-and-reset
{
  "email": "john@gmail.com",
  "otpCode": "123456",
  "newPassword": "NewSecurePass123"
}

Response 200:
{
  "success": true,
  "message": "Password reset successful. Your account is now verified.",
  "user": {
    "isVerified": true,
    "verifiedAt": "2024-01-15T10:30:00Z",
    "verificationMethod": "password_reset_otp"
  }
}
```

### 5. Check Verification Status
```
GET /api/auth/verification-status
Headers: Authorization: Bearer <accessToken>

Response 200:
{
  "isVerified": true,
  "verifiedAt": "2024-01-15T10:30:00Z",
  "verificationMethod": "password_reset_otp"
}
```

---

## Error Codes & Messages

### Registration
- **400**: Email already registered
- **400**: Invalid email format
- **400**: Weak password
- **400**: First name and last name required

### Login
- **400**: Invalid email or password
- **429**: Account temporarily locked (too many failed attempts)
- **400**: Account inactive

### Forgot Password
- **200**: OTP sent (always - account enumeration protection)
- **400**: Email not provided

### OTP Verification
- **400**: Invalid or expired OTP
- **429**: Too many failed attempts. Try again in 30 minutes
- **400**: OTP already used

---

## Rate Limiting Strategy

```
Registration: 10 per IP per hour
Login attempts: 5 failed per account per 30 min (locks account)
OTP creation: 5 per email per hour
OTP verification: 5 failed attempts per OTP (then locks)
```

---

## Migration Strategy for Existing Users

```javascript
// Run migration to add new fields
db.users.updateMany(
  {},
  {
    $set: {
      isVerified: { $cond: ['$emailVerified', true, false] },
      verifiedAt: {
        $cond: ['$emailVerified', '$updatedAt', null]
      },
      verificationMethod: {
        $cond: ['$emailVerified', 'registration_otp', null]
      }
    }
  }
)

// Existing verified users: isVerified = true, verificationMethod = 'registration_otp'
// Existing unverified users: isVerified = false, verificationMethod = null
// Both can login (no verification requirement)
```

---

## Future Enhancements

1. **Two-Factor Authentication (2FA)**
   - Enable via `/api/auth/2fa/enable`
   - Verify with TOTP during login

2. **Social Sign-In**
   - Keep existing OAuth integration
   - Auto-verify on OAuth signup

3. **Passwordless Auth**
   - Magic link via email
   - Biometric verification

4. **Account Recovery**
   - Recovery codes
   - Backup email address

5. **Advanced Analytics**
   - Login patterns
   - Anomaly detection
   - Risk scoring

---

## Implementation Checklist

- [ ] Update User model with new fields
- [ ] Update OTP model with security fields
- [ ] Create updated authService (no OTP on registration)
- [ ] Create updated otpService (hashed, rate-limited)
- [ ] Create password reset service with OTP
- [ ] Update registration endpoint
- [ ] Update login endpoint
- [ ] Create forgot password endpoint
- [ ] Create OTP verification endpoint
- [ ] Implement rate limiting middleware
- [ ] Add validation middleware
- [ ] Add error handling & logging
- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Run security audit
- [ ] Migration script for existing users
- [ ] Documentation for developers
- [ ] API documentation (OpenAPI/Swagger)

---

## Summary

This redesigned authentication system prioritizes:
1. **User experience**: Immediate registration and login
2. **Security**: Hashed OTPs, rate limiting, account lockout
3. **Privacy**: Account enumeration protection
4. **Flexibility**: Optional verification, multiple verification methods
5. **Scalability**: Stateless tokens, efficient indexing

The first successful password-reset OTP verification automatically marks an account as verified, enabling deferred email confirmation without friction.
