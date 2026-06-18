const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
}
const env = {
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/kiara_ai',
};
const PersonProfile = require('./src/models/PersonProfile');
(async () => {
  try {
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
    console.log('connected to', env.mongoUri);
    const docs = await PersonProfile.find({}).lean();
    console.log('count', docs.length);
    for (const doc of docs) {
      console.log(JSON.stringify({
        _id: doc._id?.toString?.(),
        name: doc.name,
        relationship: doc.relationship,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        lastMeeting: doc.lastMeeting,
        meetingsCount: doc.meetingsCount,
        faceDescriptor: Array.isArray(doc.faceDescriptor) ? doc.faceDescriptor.length : null,
        voiceDescriptor: Array.isArray(doc.voiceDescriptor) ? doc.voiceDescriptor.length : null,
      }, null, 2));
    }
    const dupNames = docs.reduce((acc, doc) => {
      const key = (doc.name || '').trim();
      if (!key) return acc;
      (acc[key] = acc[key] || []).push(doc._id.toString());
      return acc;
    }, {});
    console.log('duplicateNames', Object.fromEntries(Object.entries(dupNames).filter(([, ids]) => ids.length > 1)));
    const nullNames = docs.filter((doc) => doc.name == null || !String(doc.name).trim()).map((doc) => doc._id.toString());
    console.log('nullOrEmptyNames', nullNames);
    const guestProfiles = docs.filter((doc) => doc.relationship === 'guest').map((doc) => doc._id.toString());
    console.log('guestProfiles', guestProfiles.length);
    const devProfiles = docs.filter((doc) => String(doc.name || '').toLowerCase().includes('dev')).map((doc) => ({ _id: doc._id.toString(), name: doc.name }));
    console.log('devProfiles', devProfiles);
    const aryanProfiles = docs.filter((doc) => String(doc.name || '').toLowerCase().includes('aryan')).map((doc) => ({ _id: doc._id.toString(), name: doc.name }));
    console.log('aryanProfiles', aryanProfiles);
    await mongoose.disconnect();
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
})();
