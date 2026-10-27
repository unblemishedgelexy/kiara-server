const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const multer = require('multer');
const Joi = require('joi');
const mongoose = require('mongoose');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const { requireRoles } = require('../middleware/requireAdmin');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const RazorpayPayment = require('../models/RazorpayPayment');
const SupportRequest = require('../models/SupportRequest');
const WebsiteContent = require('../models/WebsiteContent');
const { uploadsDir } = require('../services/infrastructure/uploadService');
const {
  deleteFileFromImageKit,
  isImageKitConfigured,
  uploadFileStreamToImageKit,
} = require('../services/imageService');
const { deleteApkFromR2 } = require('../services/r2StorageService');
const redisService = require('../services/infrastructure/redisService');
const perfCollector = require('../middleware/perfCollector');
const { env } = require('../config/env');

const router = express.Router();
const apkDirectory = path.resolve(uploadsDir, 'admin-apk-temp');
const defaultContent = {
  announcement: '',
  heroEyebrow: 'YOUR AI COMPANION',
  heroTitle: 'A little closer to the future.',
  heroDescription: 'Meet Kiara — a thoughtful AI companion who listens, remembers, and grows with you.',
  features: ['Natural voice and chat', 'A companion that remembers', 'Your own expressive 3D avatar'],
};

const apkUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, callback) => {
      try {
        await fs.mkdir(apkDirectory, { recursive: true });
        callback(null, apkDirectory);
      } catch (error) {
        callback(error);
      }
    },
    filename: (_req, _file, callback) => callback(null, `kiara-release-${Date.now()}-${Math.random().toString(16).slice(2)}.apk`),
  }),
  fileFilter: (_req, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.apk') {
      return callback(new Error('Only Android .apk files are accepted.'));
    }
    return callback(null, true);
  },
  limits: { fileSize: env.imagekitMaxApkSizeBytes, files: 1 },
});

function pageOptions(query) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 20));
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '';
  return { page, limit, q };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function apkDownloadUrl(content) {
  if (!content.apkUrl) return null;
  if (content.apkStorageProvider === 'r2') return content.apkUrl;
  return `${env.serverUrl.replace(/\/+$/, '')}/api/site/apk`;
}

function publicContent(content) {
  return {
    announcement: content.announcement,
    heroEyebrow: content.heroEyebrow,
    heroTitle: content.heroTitle,
    heroDescription: content.heroDescription,
    features: content.features,
    apkAvailable: Boolean(content.apkUrl),
    apkDownloadUrl: apkDownloadUrl(content),
    apkOriginalName: content.apkOriginalName,
    apkSize: content.apkSize,
    apkUploadedAt: content.apkUploadedAt,
    apkMaxSizeBytes: env.imagekitMaxApkSizeBytes,
  };
}

function adminContent(content) {
  return {
    ...publicContent(content),
    apkStorageConfigured: isImageKitConfigured(),
    apkStorageProvider: content.apkStorageProvider || null,
  };
}

async function readWebsiteContent() {
  const content = await WebsiteContent.findById('public').lean();
  return content || { ...defaultContent, apkUrl: null };
}

router.get('/site/content', async (_req, res, next) => {
  try {
    return res.json({ success: true, data: publicContent(await readWebsiteContent()) });
  } catch (error) {
    return next(error);
  }
});

router.get('/site/apk', async (req, res, next) => {
  try {
    const content = await readWebsiteContent();
    if (!content.apkUrl) {
      return res.status(404).json({ success: false, message: 'No Android app has been published yet.' });
    }
    if (content.apkStorageProvider === 'r2') {
      return res.redirect(302, content.apkUrl);
    }

    const requestHeaders = {};
    if (req.headers.range) requestHeaders.Range = req.headers.range;
    if (req.headers['if-range']) requestHeaders['If-Range'] = req.headers['if-range'];
    let imageKitResponse;
    try {
      imageKitResponse = await fetch(content.apkUrl, {
        method: req.method,
        headers: requestHeaders,
      });
    } catch (error) {
      console.error('[PUBLIC_APK_IMAGEKIT_DOWNLOAD_FAILED]', error?.name || 'ImageKitError');
      return res.status(502).json({ success: false, message: 'The published APK could not be downloaded from ImageKit.' });
    }

    if (imageKitResponse.status === 416) {
      const contentRange = imageKitResponse.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      return res.status(416).end();
    }
    if (!imageKitResponse.ok || (!imageKitResponse.body && req.method !== 'HEAD')) {
      console.error('[PUBLIC_APK_IMAGEKIT_DOWNLOAD_FAILED]', imageKitResponse.status);
      return res.status(502).json({ success: false, message: 'The published APK could not be downloaded from ImageKit.' });
    }

    const originalName = typeof content.apkOriginalName === 'string' ? content.apkOriginalName : 'kiara.apk';
    const filename = originalName.split(/[\\/]/).pop().replace(/[^\w.-]/g, '-') || 'kiara.apk';
    const apkFilename = filename.toLowerCase().endsWith('.apk') ? filename : `${filename}.apk`;
    res.status(imageKitResponse.status);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${apkFilename}"`);
    res.setHeader('Accept-Ranges', imageKitResponse.headers.get('accept-ranges') || 'bytes');
    for (const header of ['content-length', 'content-range']) {
      const value = imageKitResponse.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (req.method === 'HEAD') return res.end();

    try {
      await pipeline(Readable.fromWeb(imageKitResponse.body), res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
      } else {
        return next(error);
      }
    }
  } catch (error) {
    return next(error);
  }
});

router.use('/admin', adminAuthMiddleware, requireAdmin);

router.get('/admin/overview', async (_req, res, next) => {
  try {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [users, activeUsers, newUsers, activeSubscriptions, subscriptions, revenue, feedback, redis] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isActive: true }),
      User.countDocuments({ createdAt: { $gte: monthAgo } }),
      Subscription.countDocuments({ status: 'active' }),
      Subscription.countDocuments(),
      RazorpayPayment.aggregate([
        { $match: { status: 'captured' } },
        { $group: { _id: null, totalPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
      ]),
      SupportRequest.aggregate([
        { $group: { _id: null, total: { $sum: 1 }, open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } }, averageRating: { $avg: '$rating' } } },
      ]),
      Promise.resolve(redisService.getRedisDiagnostics()),
    ]);
    return res.json({
      success: true,
      data: {
        role: _req.adminRole,
        counts: {
          users,
          activeUsers,
          newUsersThisMonth: newUsers,
          subscriptions,
          activeSubscriptions,
          payments: revenue[0]?.count || 0,
          revenuePaise: revenue[0]?.totalPaise || 0,
          feedback: feedback[0]?.total || 0,
          openFeedback: feedback[0]?.open || 0,
          averageRating: feedback[0]?.averageRating ?? null,
        },
        health: {
          mongodb: mongoose.connection.readyState === 1,
          redis: redis.isReady,
          checkedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/admin/app-performance', (_req, res) => {
  const summary = perfCollector.getSummary();
  return res.json({
    success: true,
    data: {
      timestamp: summary.timestamp,
      stages: summary.stages,
    },
  });
});

router.get('/admin/users', async (req, res, next) => {
  try {
    const { page, limit, q } = pageOptions(req.query);
    const filter = q
      ? { $or: [{ email: new RegExp(escapeRegex(q), 'i') }, { firstName: new RegExp(escapeRegex(q), 'i') }, { lastName: new RegExp(escapeRegex(q), 'i') }] }
      : {};
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    const [items, total] = await Promise.all([
      User.find(filter)
        .select('firstName lastName displayName email role mode isActive emailVerified lastLogin createdAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    return res.json({ success: true, data: { items, page, limit, total } });
  } catch (error) {
    return next(error);
  }
});

router.patch('/admin/users/:id/status', requireRoles('admin'), async (req, res, next) => {
  const schema = Joi.object({ isActive: Joi.boolean().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.message });
  try {
    if (value.isActive === false) {
      const target = await User.findById(req.params.id).select('role').lean();
      if (target?.role === 'admin') {
        return res.status(403).json({ success: false, message: 'Administrator accounts cannot be deactivated here.' });
      }
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: value.isActive } },
      { new: true, runValidators: true },
    ).select('firstName lastName email role isActive');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({ success: true, data: user });
  } catch (error) {
    if (error.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid user ID.' });
    return next(error);
  }
});

router.get('/admin/subscriptions', async (req, res, next) => {
  try {
    const { page, limit, q } = pageOptions(req.query);
    const filter = req.query.status && req.query.status !== 'all'
      ? { status: String(req.query.status).slice(0, 32) }
      : {};
    if (q) {
      const expression = new RegExp(escapeRegex(q), 'i');
      const matchingUsers = await User.find({
        $or: [{ email: expression }, { firstName: expression }, { lastName: expression }],
      }).distinct('_id');
      filter.userId = { $in: matchingUsers };
    }
    const [items, total] = await Promise.all([
      Subscription.find(filter)
        .populate({ path: 'userId', select: 'email firstName lastName' })
        .select('userId planId status amountPaise currency startedAt renewalDate expiresAt createdAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Subscription.countDocuments(filter),
    ]);
    return res.json({ success: true, data: { items, page, limit, total } });
  } catch (error) {
    return next(error);
  }
});

async function listSupportRequests(req, res, next, category) {
  try {
    const { page, limit } = pageOptions(req.query);
    const filter = req.query.status && req.query.status !== 'all'
      ? { status: String(req.query.status).slice(0, 32) }
      : {};
    if (category === 'helpdesk') {
      filter.$and = [
        { type: { $ne: 'session_feedback' } },
        { subject: { $nin: ['Kiara session feedback', 'Kiara session issue report'] } },
      ];
    } else if (category === 'feedback') {
      filter.$and = [{
        $or: [
          { type: 'session_feedback' },
          { subject: { $in: ['Kiara session feedback', 'Kiara session issue report'] } },
        ],
      }];
    }
    const [items, total] = await Promise.all([
      SupportRequest.find(filter)
        .populate({ path: 'userId', select: 'email firstName lastName' })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SupportRequest.countDocuments(filter),
    ]);
    return res.json({ success: true, data: { items, page, limit, total } });
  } catch (error) {
    return next(error);
  }
}

router.get('/admin/feedback', (req, res, next) => listSupportRequests(req, res, next, 'feedback'));
router.get('/admin/helpdesk', (req, res, next) => listSupportRequests(req, res, next, 'helpdesk'));

router.patch('/admin/feedback/:id/status', requireRoles('admin', 'dev'), async (req, res, next) => {
  const schema = Joi.object({ status: Joi.string().valid('open', 'in_progress', 'resolved').required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.message });
  try {
    const item = await SupportRequest.findByIdAndUpdate(
      req.params.id,
      { $set: { status: value.status } },
      { new: true, runValidators: true },
    );
    if (!item) return res.status(404).json({ success: false, message: 'Feedback not found.' });
    return res.json({ success: true, data: item });
  } catch (error) {
    if (error.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid feedback ID.' });
    return next(error);
  }
});

router.get('/admin/content', async (_req, res, next) => {
  try {
    return res.json({ success: true, data: adminContent(await readWebsiteContent()) });
  } catch (error) {
    return next(error);
  }
});

router.patch('/admin/content', requireRoles('admin'), async (req, res, next) => {
  const schema = Joi.object({
    announcement: Joi.string().max(180).required(),
    heroEyebrow: Joi.string().max(80).required(),
    heroTitle: Joi.string().max(120).required(),
    heroDescription: Joi.string().max(600).required(),
    features: Joi.array().items(Joi.string().trim().min(1).max(100)).length(3).required(),
  }).unknown(false);
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.message });
  try {
    const updated = await WebsiteContent.findByIdAndUpdate(
      'public',
      { $set: value, $setOnInsert: { _id: 'public' } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    return res.json({ success: true, data: adminContent(updated) });
  } catch (error) {
    return next(error);
  }
});

router.post('/admin/content/apk', requireRoles('admin', 'dev'), (req, res, next) => {
  if (!isImageKitConfigured()) {
    return res.status(503).json({
      success: false,
      message: 'ImageKit is not configured. Add IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, and IMAGEKIT_URL_ENDPOINT to the server environment.',
    });
  }

  apkUpload.single('apk')(req, res, async (uploadError) => {
    if (uploadError) {
      const message = uploadError.code === 'LIMIT_FILE_SIZE'
        ? `APK exceeds the ImageKit upload limit of 25 MB (26,214,400 bytes).`
        : uploadError.message;
      return res.status(uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        .json({ success: false, message });
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'Choose an Android .apk file.' });

    let uploadedImageKitFileId;
    try {
      const handle = await fs.open(req.file.path, 'r');
      const signature = Buffer.alloc(8);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      await handle.close();
      if (bytesRead < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b
        || ![0x03, 0x05, 0x07].includes(signature[2])
        || ![0x04, 0x06, 0x08].includes(signature[3])) {
        await fs.unlink(req.file.path);
        return res.status(400).json({ success: false, message: 'The uploaded file is not a valid APK archive.' });
      }

      const safeOriginalName = path.basename(req.file.originalname).replace(/[^\w.-]+/g, '-').slice(-120) || 'kiara.apk';
      let imageKitResult;
      try {
        imageKitResult = await uploadFileStreamToImageKit(req.file.path, safeOriginalName, '/kiara-apk');
      } catch (error) {
        console.error('[ADMIN_APK_IMAGEKIT_UPLOAD_FAILED]', error?.name || 'ImageKitError', error?.code || 'UNKNOWN');
        return res.status(502).json({
          success: false,
          message: 'ImageKit could not store this APK. Check the ImageKit credentials and plan upload limit, then try again.',
        });
      }
      if (!imageKitResult.url || !imageKitResult.fileId) {
        throw new Error('ImageKit did not return an APK URL and file ID.');
      }
      uploadedImageKitFileId = imageKitResult.fileId;
      const existing = await WebsiteContent.findById('public').select('apkFileId apkStorageProvider apkStorageKey').lean();
      const updated = await WebsiteContent.findByIdAndUpdate(
        'public',
        {
          $set: {
            apkFileId: imageKitResult.fileId,
            apkStorageProvider: 'imagekit',
            apkStorageKey: null,
            apkUrl: imageKitResult.url,
            apkOriginalName: safeOriginalName,
            apkSize: req.file.size,
            apkUploadedAt: new Date(),
          },
          $setOnInsert: { _id: 'public' },
        },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
      ).lean();
      if (existing?.apkStorageProvider === 'r2' && existing.apkStorageKey) {
        await deleteApkFromR2(existing.apkStorageKey).catch((error) => {
          console.error('[ADMIN_APK_R2_CLEANUP_FAILED]', error?.name || error?.code || 'CloudflareR2Error');
        });
      } else if (existing?.apkFileId && existing.apkFileId !== imageKitResult.fileId) {
        await deleteFileFromImageKit(existing.apkFileId).catch((error) => {
          console.error('[ADMIN_OLD_APK_CLEANUP_FAILED]', error?.name || error?.code || 'ImageKitError');
        });
      }
      return res.status(201).json({ success: true, data: adminContent(updated) });
    } catch (error) {
      if (uploadedImageKitFileId) {
        await deleteFileFromImageKit(uploadedImageKitFileId).catch((cleanupError) => {
          console.error('[ADMIN_APK_ROLLBACK_FAILED]', cleanupError?.name || cleanupError?.code || 'ImageKitError');
        });
      }
      return next(error);
    } finally {
      await fs.unlink(req.file.path).catch((error) => {
        if (error.code !== 'ENOENT') {
          console.error('[ADMIN_APK_TEMP_CLEANUP_FAILED]', error?.code || error?.name || 'file_error');
        }
      });
    }
  });
});

router.delete('/admin/content/apk', requireRoles('admin'), async (_req, res, next) => {
  try {
    const existing = await WebsiteContent.findById('public').select('apkFileId apkStorageProvider apkStorageKey apkUrl').lean();
    if (!existing?.apkUrl) {
      return res.status(404).json({ success: false, message: 'There is no published APK to remove.' });
    }
    if (existing.apkStorageProvider === 'r2' && existing.apkStorageKey) {
      await deleteApkFromR2(existing.apkStorageKey);
    } else if (existing.apkFileId) {
      await deleteFileFromImageKit(existing.apkFileId);
    }
    const updated = await WebsiteContent.findByIdAndUpdate(
      'public',
      { $set: { apkFileId: null, apkStorageProvider: null, apkStorageKey: null, apkUrl: null, apkOriginalName: null, apkSize: null, apkUploadedAt: null } },
      { new: true },
    ).lean();
    return res.json({ success: true, data: adminContent(updated) });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
