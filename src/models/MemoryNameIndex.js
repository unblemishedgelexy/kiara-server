const mongoose = require('mongoose');

const memoryNameIndexSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    personName: { type: String, required: true, index: true },
    personNameLower: { type: String, required: true, index: true, lowercase: true },
    relationshipType: { type: String, default: '' },
    memoryId: { type: String, required: true, index: true },
    category: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

memoryNameIndexSchema.index({ userId: 1, personNameLower: 1 });
memoryNameIndexSchema.index({ userId: 1, relationshipType: 1 });

module.exports = mongoose.models.MemoryNameIndex || mongoose.model('MemoryNameIndex', memoryNameIndexSchema, 'memory_name_index');
