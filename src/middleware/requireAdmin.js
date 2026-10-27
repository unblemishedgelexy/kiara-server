const AdminModel = require('../models/Admin');

function hasAdminPanelAccess(user) {
  return Boolean(user?.isActive && ['admin', 'dev'].includes(user.role));
}

async function requireAdmin(req, res, next) {
  try {
    const admin = await AdminModel.findById(req.adminId || req.userId).select('role isActive').lean();
    if (!hasAdminPanelAccess(admin)) {
      return res.status(403).json({ success: false, message: 'Administrator or developer access required.' });
    }
    req.adminRole = admin.role;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.adminRole)) {
      return res.status(403).json({ success: false, message: 'Your account cannot perform this action.' });
    }
    return next();
  };
}

module.exports = requireAdmin;
module.exports.requireRoles = requireRoles;
module.exports.hasAdminPanelAccess = hasAdminPanelAccess;
