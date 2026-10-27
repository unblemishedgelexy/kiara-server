const assert = require('node:assert/strict');
const test = require('node:test');
const Admin = require('../models/Admin');
const User = require('../models/User');
const requireAdmin = require('./requireAdmin');
const { hasAdminPanelAccess, requireRoles } = require('./requireAdmin');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function runAdminGuard(user) {
  const previousFindById = Admin.findById;
  Admin.findById = () => ({
    select() {
      return this;
    },
    lean: async () => user,
  });

  const req = { userId: 'test-user' };
  const res = createResponse();
  let nextCalled = false;
  try {
    await requireAdmin(req, res, () => {
      nextCalled = true;
    });
    return { req, res, nextCalled };
  } finally {
    Admin.findById = previousFindById;
  }
}

test('admin and dev accounts are admitted and their current roles are attached', async () => {
  for (const role of ['admin', 'dev']) {
    const result = await runAdminGuard({ role, isActive: true });
    assert.equal(result.nextCalled, true);
    assert.equal(result.req.adminRole, role);
  }
});

test('regular or inactive accounts are denied', async () => {
  for (const user of [{ role: 'user', isActive: true }, { role: 'dev', isActive: false }]) {
    const result = await runAdminGuard(user);
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 403);
  }
});

test('only active admin and developer accounts may enter the admin panel', () => {
  assert.equal(hasAdminPanelAccess({ role: 'admin', isActive: true }), true);
  assert.equal(hasAdminPanelAccess({ role: 'dev', isActive: true }), true);
  assert.equal(hasAdminPanelAccess({ role: 'user', isActive: true }), false);
  assert.equal(hasAdminPanelAccess({ role: 'admin', isActive: false }), false);
  assert.equal(hasAdminPanelAccess(null), false);
});

test('developer role cannot use admin-only mutations', () => {
  const req = { adminRole: 'dev' };
  const res = createResponse();
  let nextCalled = false;

  requireRoles('admin')(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('developer role can use explicitly shared mutation permissions', () => {
  const req = { adminRole: 'dev' };
  const res = createResponse();
  let nextCalled = false;

  requireRoles('admin', 'dev')(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('user schema accepts the developer role for owner-assigned upgrades', () => {
  assert.deepEqual(User.schema.path('role').enumValues, ['user', 'dev', 'admin']);
});
