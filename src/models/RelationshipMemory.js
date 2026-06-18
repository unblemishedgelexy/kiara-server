const mongoose = require('mongoose');
const { createMemorySchema } = require('./MemoryBase');

const relationshipMemorySchema = createMemorySchema();

module.exports = mongoose.models.RelationshipMemory || mongoose.model('RelationshipMemory', relationshipMemorySchema, 'relationship_memory');