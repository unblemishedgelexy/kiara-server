const mongoose = require('mongoose');
const { createMemorySchema } = require('./MemoryBase');

const projectMemorySchema = createMemorySchema();

module.exports = mongoose.models.ProjectMemory || mongoose.model('ProjectMemory', projectMemorySchema, 'project_memory');