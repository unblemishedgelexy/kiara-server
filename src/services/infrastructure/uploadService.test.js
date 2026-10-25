const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { hasValidImageSignature, removeFile } = require('./uploadService');

const testDirectory = path.join(os.tmpdir(), `kiara-upload-signature-${process.pid}`);

test('validates JPEG, PNG, and WEBP file signatures', async () => {
  await fs.mkdir(testDirectory, { recursive: true });
  const files = [
    ['jpeg.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00])],
    ['png.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['webp.webp', 'image/webp', Buffer.from('RIFF0000WEBP')],
  ];

  for (const [name, _mime, contents] of files) {
    await fs.writeFile(path.join(testDirectory, name), contents);
  }

  for (const [name, mime] of files) {
    assert.equal(await hasValidImageSignature(path.join(testDirectory, name), mime), true);
  }
});

test('rejects spoofed image MIME types and short WEBP signatures', async () => {
  await fs.mkdir(testDirectory, { recursive: true });
  const spoofedPath = path.join(testDirectory, 'spoofed.jpg');
  const shortWebpPath = path.join(testDirectory, 'short.webp');
  await fs.writeFile(spoofedPath, '<html>not an image</html>');
  await fs.writeFile(shortWebpPath, 'RIFF0000WEB');

  assert.equal(await hasValidImageSignature(spoofedPath, 'image/jpeg'), false);
  assert.equal(await hasValidImageSignature(shortWebpPath, 'image/webp'), false);
});

test('ignores missing files but surfaces other cleanup errors', async () => {
  await fs.mkdir(testDirectory, { recursive: true });
  await assert.doesNotReject(removeFile(path.join(testDirectory, 'missing.jpg')));
  await assert.rejects(removeFile(testDirectory));
});

test.after(async () => {
  await fs.rm(testDirectory, { recursive: true, force: true });
});
