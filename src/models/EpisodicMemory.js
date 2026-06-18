const mongoose = require('mongoose');
const { createMemorySchema } = require('./MemoryBase');

const episodicMemorySchema = createMemorySchema();

episodicMemorySchema.add({
  eventDate: { type: Date },
});

module.exports = mongoose.models.EpisodicMemory || mongoose.model('EpisodicMemory', episodicMemorySchema, 'episodic_memory');