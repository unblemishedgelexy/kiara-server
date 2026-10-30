'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { separateLegacyAdminAccount } = require('./legacyAdminSeparation');

function createModels(existingAdmin = null) {
  const state = {
    admin: existingAdmin,
    createdAdmin: null,
    updatedUser: null,
  };
  const AdminModel = {
    findOne: () => ({ lean: async () => state.admin }),
    create: async (account) => {
      state.admin = account;
      state.createdAdmin = account;
      return account;
    },
  };
  const UserModel = {
    updateOne: async (filter, update) => {
      state.updatedUser = { filter, update };
      return { modifiedCount: 1 };
    },
  };
  return { AdminModel, UserModel, state };
}

test('moves a legacy user-admin identity to the separate admin collection before demoting its user record', async () => {
  const { AdminModel, UserModel, state } = createModels();
  const account = {
    _id: 'legacy-admin-id',
    email: 'admin@example.com',
    role: 'admin',
    passwordHash: 'stored-password-hash',
    emailVerified: true,
    isActive: true,
  };

  assert.equal(await separateLegacyAdminAccount(account, { AdminModel, UserModel }), true);
  assert.equal(state.createdAdmin._id, account._id);
  assert.equal(state.createdAdmin.role, 'admin');
  assert.equal(state.createdAdmin.passwordHash, account.passwordHash);
  assert.deepEqual(state.updatedUser.filter, { _id: account._id, role: 'admin' });
  assert.deepEqual(state.updatedUser.update, { $set: { role: 'user' } });
  assert.equal(account.role, 'user');
});

test('preserves an existing separate admin account while normalizing the legacy user record', async () => {
  const separateAdmin = { _id: 'separate-admin-id', email: 'admin@example.com', role: 'admin' };
  const { AdminModel, UserModel, state } = createModels(separateAdmin);
  const account = { _id: 'legacy-admin-id', email: 'admin@example.com', role: 'dev' };

  assert.equal(await separateLegacyAdminAccount(account, { AdminModel, UserModel }), true);
  assert.equal(state.createdAdmin, null);
  assert.deepEqual(state.updatedUser.filter, { _id: account._id, role: 'dev' });
  assert.equal(account.role, 'user');
});

test('does not change regular user records', async () => {
  const { AdminModel, UserModel, state } = createModels();
  const account = { _id: 'user-id', email: 'user@example.com', role: 'user' };

  assert.equal(await separateLegacyAdminAccount(account, { AdminModel, UserModel }), false);
  assert.equal(state.createdAdmin, null);
  assert.equal(state.updatedUser, null);
});
