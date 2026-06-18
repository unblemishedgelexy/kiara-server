const mongoose = require('mongoose');

const embeddingSchema = new mongoose.Schema({
  vector: [Number],
  timestamp: {
    type: Date,
    default: Date.now
  },
  quality: {
    type: Number,
    min: 0,
    max: 1
  }
});

const personProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true
    },

    name: {
      type: String,
      required: true
    },

    relationship: {
      type: String,
      enum: ['family', 'friend', 'colleague', 'guest', 'unknown'],
      default: 'guest'
    },

    faceEmbeddings: [embeddingSchema],
    voiceEmbeddings: [embeddingSchema],

    faceConfidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0
    },

    voiceConfidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0
    },

    meetingsCount: {
      type: Number,
      default: 0
    },

    lastMeeting: Date,

    learningLevel: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

personProfileSchema.index({ userId: 1, name: 1 });

module.exports = mongoose.model('PersonProfile', personProfileSchema);