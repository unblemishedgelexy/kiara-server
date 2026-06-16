const mongoose = require('mongoose');

const embeddingSchema = new mongoose.Schema({
  vector: [Number],
  timestamp: Date,
  quality: Number, // 0-1 confidence score
});

const personProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    relationship: {
      type: String,
      enum: ['family', 'friend', 'colleague', 'guest', 'unknown'],
      default: 'guest',
    },
    // Face recognition data
    faceEmbeddings: [embeddingSchema],
    faceDescriptor: mongoose.Schema.Types.Mixed, // face-api descriptor for comparison
    lastFaceCapture: Date,
    faceConfidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0,
    },
    // Voice recognition data
    voiceEmbeddings: [embeddingSchema],
    voiceDescriptor: mongoose.Schema.Types.Mixed, // voice characteristics
    lastVoiceCapture: Date,
    voiceConfidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0,
    },
    // Interaction tracking
    meetingsCount: {
      type: Number,
      default: 0,
    },
    lastMeeting: Date,
    recognitionHistory: [
      {
        timestamp: Date,
        faceScore: Number,
        voiceScore: Number,
        overallConfidence: Number,
        source: String, // 'face', 'voice', or 'both'
      },
    ],
    // Learning metadata
    isLearned: {
      type: Boolean,
      default: false,
    },
    learningLevel: {
      type: Number,
      min: 0,
      max: 100,
      default: 0, // 0: guest, 50: acquaintance, 100: well-known
    },
    notes: String,
  },
  {
    timestamps: true,
  },
);

// Index for faster queries
personProfileSchema.index({ userId: 1, name: 1 });
personProfileSchema.index({ userId: 1, lastMeeting: -1 });

module.exports = mongoose.model('PersonProfile', personProfileSchema);
