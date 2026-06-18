const mongoose = require('mongoose');
const { createMemorySchema } = require('./MemoryBase');

const identityMemorySchema = createMemorySchema();

module.exports = mongoose.models.IdentityMemory || mongoose.model('IdentityMemory', identityMemorySchema, 'identity_memory');