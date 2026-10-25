const UserModel = require('../models/User');
const path = require('path');
const { removeFile, uploadsDir, hasValidImageSignature } = require('../services/../services/infrastructure/uploadService');
const { uploadFileToImageKit, deleteFileFromImageKit } = require('../services/imageService');

function serializeProfile(user) {
  const profile = user.toObject();
  const sensitiveActionRequiresPassword = profile.passwordLoginEnabled === true
    || (!profile.googleId && profile.passwordLoginEnabled !== false);
  delete profile.passwordLoginEnabled;
  delete profile.googleId;
  return { ...profile, sensitiveActionRequiresPassword };
}

async function getProfile(req, res, next) {
  try {
    // include email verification flag so frontend can show verification UI
    const user = await UserModel.findById(req.userId).select(
      'firstName lastName email mobileNumber profilePicture emailVerified termsVersion termsAcceptedAt privacyVersion privacyAcceptedAt passwordLoginEnabled googleId',
    );
    if (!user) return res.status(404).json({ success: false, message: 'Profile not found' });
    res.json({ success: true, data: serializeProfile(user) });
  } catch (err) { next(err); }
}

async function updateProfile(req, res, next) {
  try {
    const { firstName, lastName } = req.body;
    const updates = {};
    if (firstName) updates.firstName = firstName.trim();
    if (lastName) updates.lastName = lastName.trim();
    const user = await UserModel.findByIdAndUpdate(req.userId, updates, { returnDocument: 'after' }).select(
      'firstName lastName email mobileNumber profilePicture emailVerified termsVersion termsAcceptedAt privacyVersion privacyAcceptedAt passwordLoginEnabled googleId',
    );
    res.json({ success: true, data: user ? serializeProfile(user) : null });
  } catch (err) { next(err); }
}

async function uploadProfilePicture(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    if (!(await hasValidImageSignature(req.file.path, req.file.mimetype))) {
      await removeFile(req.file.filename);
      return res.status(400).json({ success: false, message: 'Uploaded file is not a valid image.' });
    }
    const user = await UserModel.findById(req.userId);
    if (!user) {
      await removeFile(req.file.filename);
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const previousLocalFilename = typeof user.profilePicture === 'string'
      ? path.basename(user.profilePicture)
      : '';
    const previousImageKitFileId = user.profilePictureFileId;
    if (/^profile-[\w-]+\.(?:jpe?g|png|webp)$/i.test(previousLocalFilename)) {
      await removeFile(previousLocalFilename);
    }

    // Upload the file from local uploads to ImageKit
    const localPath = path.join(uploadsDir, req.file.filename);
    let imagekitResult;
    try {
      imagekitResult = await uploadFileToImageKit(localPath, req.file.filename);
    } catch (uploadErr) {
      await removeFile(req.file.filename);
      console.error('ImageKit upload failed:', { name: uploadErr.name, code: uploadErr.code });
      return res.status(503).json({ success: false, message: 'Image upload is temporarily unavailable.' });
    }

    // Remove local file after successful upload
    await removeFile(req.file.filename);

    // Save the ImageKit URL to user profile
    user.profilePicture = imagekitResult.url || imagekitResult.filePath || '';
    user.profilePictureFileId = imagekitResult.fileId || undefined;
    await user.save();
    let previousImageCleanupFailed = false;
    if (previousImageKitFileId && previousImageKitFileId !== user.profilePictureFileId) {
      try {
        await deleteFileFromImageKit(previousImageKitFileId);
      } catch (cleanupError) {
        previousImageCleanupFailed = true;
        console.error('[PROFILE_IMAGE_CLEANUP_FAILED]', cleanupError?.name || cleanupError?.code || 'ImageProviderError');
      }
    }
    res.json({
      success: true,
      data: {
        profilePicture: user.profilePicture,
        ...(previousImageCleanupFailed ? { cleanupWarning: 'Previous profile image could not be removed.' } : {}),
      },
    });
  } catch (err) { next(err); }
}

module.exports = { getProfile, updateProfile, uploadProfilePicture };
