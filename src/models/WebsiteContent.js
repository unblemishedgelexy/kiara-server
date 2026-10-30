const mongoose = require('mongoose');

const websiteContentSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'public' },
    announcement: { type: String, default: '' },
    heroEyebrow: { type: String, default: 'YOUR AI COMPANION' },
    heroTitle: { type: String, default: 'A thoughtful companion for real conversations.' },
    heroDescription: {
      type: String,
      default: 'Meet Kiara, an Android AI companion for everyday conversations, clearer expression, and personal reflection.',
    },
    features: {
      type: [String],
      default: [
        'Voice and text conversations',
        'Context-aware memory',
        'An expressive 3D avatar',
      ],
    },
    apkFileId: { type: String, default: null },
    apkStorageProvider: { type: String, enum: ['imagekit', 'r2'], default: null },
    apkStorageKey: { type: String, default: null },
    apkUrl: { type: String, default: null },
    apkOriginalName: { type: String, default: null },
    apkSize: { type: Number, default: null },
    apkUploadedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

module.exports = mongoose.models.WebsiteContent
  || mongoose.model('WebsiteContent', websiteContentSchema);
