const mongoose = require('mongoose');
const { createMemorySchema } = require('./MemoryBase');

const preferenceMemorySchema = createMemorySchema();

module.exports = mongoose.models.PreferenceMemory || mongoose.model('PreferenceMemory', preferenceMemorySchema, 'preference_memory');