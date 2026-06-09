const UserModel = require('../models/User');
const path = require('path');
const { removeFile, uploadsDir } = require('../services/uploadService');
const { uploadFileToImageKit } = require('../services/imageService');

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

async function uploadProfilePicture(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const user = await UserModel.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    // Remove previous local file if stored
    await removeFile(user.profilePicture);

    // Upload the file from local uploads to ImageKit
    const localPath = path.join(uploadsDir, req.file.filename);
    let imagekitResult;
    try {
      imagekitResult = await uploadFileToImageKit(localPath, req.file.filename);
    } catch (uploadErr) {
      // Keep local file and return error
      console.error('ImageKit upload failed:', uploadErr);
      return res.status(500).json({ success: false, message: 'Image upload failed.' });
    }

    // Remove local file after successful upload
    await removeFile(req.file.filename);

    // Save the ImageKit URL to user profile
    user.profilePicture = imagekitResult.url || imagekitResult.filePath || '';
    await user.save();
    res.json({ success: true, data: { profilePicture: user.profilePicture } });
  } catch (err) { next(err); }
}

module.exports = { getProfile, updateProfile, uploadProfilePicture };
