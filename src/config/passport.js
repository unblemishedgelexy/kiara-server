const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const UserModel = require('../models/User');
const { env } = require('./env');

// Verify callback for Google
async function verifyGoogleProfile(accessToken, refreshToken, profile, done) {
  try {
    // Extract email and name from Google profile
    const email = profile.emails?.[0]?.value;
    const firstName = profile.given_name || profile.displayName?.split(' ')[0] || '';
    const lastName = profile.family_name || profile.displayName?.split(' ')[1] || '';

    if (!email) {
      return done(new Error('No email provided from Google'), null);
    }

    // Find user by googleId
    let user = await UserModel.findOne({ googleId: profile.id });

    if (user) {
      // User exists - update profile picture if available
      if (profile.photos?.[0]?.value) {
        user.profilePicture = profile.photos[0].value;
      }
      await user.save();
      return done(null, profile);
    }

    // Check if email already registered with password
    const existingEmail = await UserModel.findOne({ email: email.toLowerCase() });
    if (existingEmail) {
      // Email exists but not with Google - link it
      if (!existingEmail.googleId) {
        existingEmail.googleId = profile.id;
        existingEmail.googleEmail = email;
        if (profile.photos?.[0]?.value && !existingEmail.profilePicture) {
          existingEmail.profilePicture = profile.photos[0].value;
        }
        await existingEmail.save();
        return done(null, profile);
      }
    }

    // New user - will be created in authService.loginWithGoogle
    return done(null, profile);
  } catch (error) {
    return done(error, null);
  }
}

// Configure Passport with Google Strategy
if (env.googleClientId && env.googleClientSecret) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.googleClientId,
        clientSecret: env.googleClientSecret,
        callbackURL: `${env.serverUrl}/auth/google/callback`,
        passReqToCallback: false,
      },
      verifyGoogleProfile
    )
  );
}

// Serialize user (not really used for JWT but keeping for compatibility)
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

module.exports = passport;
