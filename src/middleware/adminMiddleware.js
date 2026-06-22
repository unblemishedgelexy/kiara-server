const UserModel = require('../models/User');
const { env } = require('../config/env');

async function adminOnlyMiddleware(req, res, next) {
  if (!env.enableMemoryLab) {
    return res.status(403).json({ success: false, message: 'Memory lab is disabled.' });
  }

  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    const user = await UserModel.findById(userId).select('role isActive');
    if (!user || user.role !== 'admin' || !user.isActive) {
      return res.status(403).json({ success: false, message: 'Developer access required.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  adminOnlyMiddleware,
};
