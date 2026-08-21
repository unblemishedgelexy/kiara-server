const mongoose = require('mongoose');

const PersonProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, trim: true, default: 'unknown' },
    nameLower: { type: String, trim: true, lowercase: true },
    relationship: { type: String, trim: true, default: 'guest' },
    descriptorKey: { type: String, trim: true, index: true },
    isLearned: { type: Boolean, default: false },
    learningLevel: { type: Number, default: 0 },
    faceDescriptor: { type: [Number], default: null },
    voiceDescriptor: { type: [Number], default: null },
    voiceCharacteristics: {
      pitch: { type: Number, default: null },
      energy: { type: Number, default: null },
      zcr: { type: Number, default: null },
    },
    faceEmbeddings: [
      {
        vector: { type: [Number], required: true },
        timestamp: { type: Date, default: Date.now },
        quality: { type: Number, default: 0 },
      },
    ],
    voiceEmbeddings: [
      {
        vector: { type: [Number], required: true },
        timestamp: { type: Date, default: Date.now },
        quality: { type: Number, default: 0 },
      },
    ],
    recognitionHistory: [
      {
        timestamp: { type: Date, default: Date.now },
        faceScore: { type: Number, default: 0 },
        voiceScore: { type: Number, default: 0 },
        overallConfidence: { type: Number, default: 0 },
        source: { type: String, trim: true },
      },
    ],
    faceConfidence: { type: Number, default: 0 },
    voiceConfidence: { type: Number, default: 0 },
    lastFaceCapture: { type: Date },
    lastVoiceCapture: { type: Date },
    meetingsCount: { type: Number, default: 0 },
    lastMeeting: { type: Date },
  },
  { timestamps: true }
);

PersonProfileSchema.index({ userId: 1, descriptorKey: 1 });

module.exports = mongoose.models.PersonProfile || mongoose.model('PersonProfile', PersonProfileSchema);
