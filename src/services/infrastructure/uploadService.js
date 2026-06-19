const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const { env } = require('../../config/env');

const uploadsDir = path.resolve(process.cwd(), env.uploadsDir || 'uploads');

async function ensureUploadsDirectory() {
  await fs.mkdir(uploadsDir, { recursive: true });
}

function fileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Invalid file type. Only JPEG, PNG and WEBP are allowed.'));
  }
  cb(null, true);
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await ensureUploadsDirectory();
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `profile-${timestamp}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: env.maxUploadSize || 2 * 1024 * 1024 },
});

async function removeFile(filePath) {
  if (!filePath) return;
  try {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(uploadsDir, filePath);
    await fs.unlink(absolute);
  } catch {
    // ignore if file was already missing
  }
}

module.exports = { upload, removeFile, uploadsDir };
