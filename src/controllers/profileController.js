const UserModel = require('../models/User');
const { createOTP, verifyOTP, sendEmailOTP } = require('../services/otpService');
const { removeFile } = require('../services/uploadService');

async function getProfile(req, res, next) {
  try {
    const user = await UserModel.findById(req.userId).select('firstName lastName email mobileNumber profilePicture');
    if (!user) return res.status(404).json({ success: false, message: 'Profile not found' });
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
}

async function updateProfile(req, res, next) {
  try {
    const { firstName, lastName } = req.body;
    const updates = {};
    if (firstName) updates.firstName = firstName.trim();
    if (lastName) updates.lastName = lastName.trim();
    const user = await UserModel.findByIdAndUpdate(req.userId, updates, { returnDocument: 'after' }).select('firstName lastName email mobileNumber profilePicture');
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
}

async function requestEmailUpdate(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    const existing = await UserModel.findOne({ email: email.toLowerCase(), _id: { $ne: req.userId } });
    if (existing) return res.status(400).json({ success: false, message: 'Email already in use' });
    const otp = await createOTP(email.toLowerCase(), 'profile_email', 300, { userId: req.userId });
    await sendEmailOTP(email, otp.code);
    res.json({ success: true, message: 'Verification code sent to new email address' });
  } catch (err) { next(err); }
}

async function verifyEmailUpdate(req, res, next) {
  try {
    const { email, code } = req.body;
    const doc = await verifyOTP(email.toLowerCase(), code, 'profile_email');
    if (!doc || String(doc.meta.userId) !== String(req.userId)) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    }
    const existing = await UserModel.findOne({ email: doc.identifier, _id: { $ne: req.userId } });
    if (existing) return res.status(400).json({ success: false, message: 'Email already taken' });
    const user = await UserModel.findByIdAndUpdate(req.userId, { email: doc.identifier, emailVerified: true }, { returnDocument: 'after' }).select('firstName lastName email mobileNumber profilePicture');
    res.json({ success: true, message: 'Email updated successfully', data: user });
  } catch (err) { next(err); }
}

async function requestMobileUpdate(req, res, next) {
  try {
    const { mobileNumber } = req.body;
    if (!mobileNumber) return res.status(400).json({ success: false, message: 'Mobile number is required' });
    const existing = await UserModel.findOne({ mobileNumber, _id: { $ne: req.userId } });
    if (existing) return res.status(400).json({ success: false, message: 'Mobile number already in use' });
    const otp = await createOTP(mobileNumber, 'profile_mobile', 300, { userId: req.userId });
    // TODO: replace with SMS provider for real production
    console.log(`Mobile OTP for ${mobileNumber}: ${otp.code}`);
    res.json({ success: true, message: 'Verification code sent to new mobile number' });
  } catch (err) { next(err); }
}

async function verifyMobileUpdate(req, res, next) {
  try {
    const { mobileNumber, code } = req.body;
    const doc = await verifyOTP(mobileNumber, code, 'profile_mobile');
    if (!doc || String(doc.meta.userId) !== String(req.userId)) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    }
    const existing = await UserModel.findOne({ mobileNumber: doc.identifier, _id: { $ne: req.userId } });
    if (existing) return res.status(400).json({ success: false, message: 'Mobile number already in use' });
    const user = await UserModel.findByIdAndUpdate(req.userId, { mobileNumber: doc.identifier, mobileVerified: true }, { returnDocument: 'after' }).select('firstName lastName email mobileNumber profilePicture');
    res.json({ success: true, message: 'Mobile updated successfully', data: user });
  } catch (err) { next(err); }
}

async function uploadProfilePicture(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const user = await UserModel.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await removeFile(user.profilePicture);
    user.profilePicture = req.file.filename;
    await user.save();
    res.json({ success: true, data: { profilePicture: user.profilePicture } });
  } catch (err) { next(err); }
}

module.exports = { getProfile, updateProfile, requestEmailUpdate, verifyEmailUpdate, requestMobileUpdate, verifyMobileUpdate, uploadProfilePicture };
