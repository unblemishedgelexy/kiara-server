const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('node:crypto');
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

async function hasValidImageSignature(filePath, mimetype) {
  const handle = await fs.open(filePath, 'r');
  try {
    const signature = Buffer.alloc(12);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (mimetype === 'image/jpeg') {
      return bytesRead >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    }
    if (mimetype === 'image/png') {
      return bytesRead >= 8 && signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    return mimetype === 'image/webp'
      && bytesRead >= 12
      && signature.toString('ascii', 0, 4) === 'RIFF'
      && signature.toString('ascii', 8, 12) === 'WEBP';
  } finally {
    await handle.close();
  }
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await ensureUploadsDirectory();
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype];
    cb(null, `profile-${randomUUID()}${ext}`);
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
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = { upload, removeFile, uploadsDir, hasValidImageSignature };
