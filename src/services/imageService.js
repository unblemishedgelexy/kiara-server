const fs = require('fs');
const path = require('path');
const ImageKit = require('@imagekit/nodejs');
const { env } = require('../config/env');

const imagekit = new ImageKit({
  publicKey: env.imagekitPublicKey,
  privateKey: env.imagekitPrivateKey,
  urlEndpoint: env.imagekitUrlEndpoint,
});

async function uploadFileToImageKit(filePath, fileName) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const buffer = await fs.promises.readFile(absolute);
  const base64 = buffer.toString('base64');

  const uploadOptions = {
    file: base64,
    fileName: fileName || `upload-${Date.now()}`,
    folder: env.imagekitFolder || '/profiles',
    useUniqueFileName: true,
    isBase64: true,
  };

  const res = await imagekit.upload(uploadOptions);
  // res.url contains the full URL
  return res;
}

module.exports = { uploadFileToImageKit };
