'use strict';

async function separateLegacyAdminAccount(userAccount, { AdminModel, UserModel }) {
  if (!userAccount || !['admin', 'dev'].includes(userAccount.role)) {
    return false;
  }

  const existingAdmin = await AdminModel.findOne({ email: userAccount.email }).lean();
  if (!existingAdmin) {
    try {
      await AdminModel.create({
        _id: userAccount._id,
        firstName: userAccount.firstName || 'Admin',
        lastName: userAccount.lastName || 'Account',
        displayName: userAccount.displayName || undefined,
        email: userAccount.email,
        passwordHash: userAccount.passwordHash,
        emailVerified: userAccount.emailVerified === true,
        role: userAccount.role,
        isActive: userAccount.isActive !== false,
        lastLogin: userAccount.lastLogin,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;

      const adminCreatedConcurrently = await AdminModel.findOne({ email: userAccount.email }).lean();
      if (!adminCreatedConcurrently) throw error;
    }
  }

  const result = await UserModel.updateOne(
    { _id: userAccount._id, role: userAccount.role },
    { $set: { role: 'user' } },
  );
  if (result.modifiedCount !== 1) {
    const currentAccount = await UserModel.findById(userAccount._id).select('role').lean();
    if (currentAccount?.role !== 'user') {
      throw new Error('Legacy administrator account could not be separated.');
    }
  }

  userAccount.role = 'user';
  return true;
}

module.exports = { separateLegacyAdminAccount };
