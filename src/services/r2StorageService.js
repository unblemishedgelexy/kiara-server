const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { DeleteObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { env } = require('../config/env');

let client;

function isR2Configured() {
  const hasCredentials = Boolean(
    env.r2AccountId
    && env.r2AccessKeyId
    && env.r2SecretAccessKey
    && env.r2BucketName
    && env.r2PublicBaseUrl,
  );
  if (!hasCredentials) return false;

  try {
    const publicUrl = new URL(env.r2PublicBaseUrl);
    return publicUrl.protocol === 'https:'
      && !publicUrl.username
      && !publicUrl.password
      && !publicUrl.search
      && !publicUrl.hash;
  } catch {
    return false;
  }
}

function getClient() {
  if (!isR2Configured()) {
    const error = new Error('Cloudflare R2 is not configured. Set the R2 account, bucket, credentials, and public URL.');
    error.code = 'R2_NOT_CONFIGURED';
    throw error;
  }

  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.r2AccessKeyId,
      secretAccessKey: env.r2SecretAccessKey,
    },
  });
  return client;
}

function buildPublicUrl(key) {
  const baseUrl = new URL(`${env.r2PublicBaseUrl.replace(/\/+$/, '')}/`);
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return new URL(encodedKey, baseUrl).toString();
}

async function uploadApkToR2(filePath, fileName) {
  const absolutePath = path.resolve(filePath);
  const stats = await fs.stat(absolutePath);
  const key = `kiara-apk/${Date.now()}-${crypto.randomUUID()}-${fileName}`;

  await getClient().send(new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    Body: createReadStream(absolutePath),
    ContentLength: stats.size,
    ContentType: 'application/vnd.android.package-archive',
    ContentDisposition: `attachment; filename="${fileName}"`,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return { key, url: buildPublicUrl(key) };
}

async function deleteApkFromR2(key) {
  if (!key) return;
  if (!key.startsWith('kiara-apk/')) {
    throw new Error('Refusing to delete an R2 object outside the Kiara APK folder.');
  }
  await getClient().send(new DeleteObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
  }));
}

module.exports = { buildPublicUrl, deleteApkFromR2, isR2Configured, uploadApkToR2 };
