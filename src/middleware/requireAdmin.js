const UserModel = require('../models/User');

function hasAdminPanelAccess(user) {
  return Boolean(user?.isActive && ['admin', 'dev'].includes(user.role));
}

async function requireAdmin(req, res, next) {
  try {
    const user = await UserModel.findById(req.userId).select('role isActive').lean();
    if (!hasAdminPanelAccess(user)) {
      return res.status(403).json({ success: false, message: 'Administrator or developer access required.' });
    }
    req.adminRole = user.role;
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
