const mongoose = require('mongoose');

const sacredMemorySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    category: { type: String, required: true, enum: ['identity', 'family', 'relationship', 'goal', 'project', 'life_fact'], index: true },
    content: { type: String, required: true },
    encryptedContent: { type: String, required: true },
    metadata: {
      personName: String,
      relationshipType: String,
      importance: { type: Number, default: 1 },
      relatedPeople: [String],
    },
    strength: {
      importanceScore: { type: Number, default: 1 },
      confidenceScore: { type: Number, default: 1 },
      memoryStrength: { type: Number, default: 1 },
      accessCount: { type: Number, default: 0 },
    },
    active: { type: Boolean, default: true, index: true },
    archivedAt: { type: Date },
    tags: [String],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    lastAccessed: Date,
  },
  { timestamps: true }
);

sacredMemorySchema.index({ userId: 1, category: 1 });
sacredMemorySchema.index({ userId: 1, 'metadata.personName': 1 });
sacredMemorySchema.index({ userId: 1, 'strength.memoryStrength': -1 });

module.exports = mongoose.model('SacredMemory', sacredMemorySchema);
