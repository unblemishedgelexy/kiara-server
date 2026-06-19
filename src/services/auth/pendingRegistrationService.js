const PendingRegistrationModel = require('../../models/PendingRegistration');

async function createPendingRegistration({ firstName, lastName, email, mobileNumber, passwordHash, ttlSeconds = 1800 }) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  return PendingRegistrationModel.create({
    firstName,
    lastName,
    email: email.toLowerCase(),
    mobileNumber,
    passwordHash,
    emailVerified: false,
    mobileVerified: false,
    expiresAt,
  });
}

async function findPendingRegistrationById(id) {
  return PendingRegistrationModel.findById(id);
}

async function findPendingRegistrationByEmail(email) {
  return PendingRegistrationModel.findOne({ email: email.toLowerCase() });
}

async function findPendingRegistrationByMobile(mobileNumber) {
  return PendingRegistrationModel.findOne({ mobileNumber });
}

async function markPendingRegistrationEmailVerified(id) {
  return PendingRegistrationModel.findByIdAndUpdate(id, { emailVerified: true }, { returnDocument: 'after' });
}

async function markPendingRegistrationMobileVerified(id) {
  return PendingRegistrationModel.findByIdAndUpdate(id, { mobileVerified: true }, { returnDocument: 'after' });
}

async function completePendingRegistration(id) {
  return PendingRegistrationModel.findByIdAndDelete(id);
}

module.exports = {
  createPendingRegistration,
  findPendingRegistrationById,
  findPendingRegistrationByEmail,
  findPendingRegistrationByMobile,
  markPendingRegistrationEmailVerified,
  markPendingRegistrationMobileVerified,
  completePendingRegistration,
};
