const mongoose = require('mongoose');
const { createMemorySchema } = require('./MemoryBase');

const goalMemorySchema = createMemorySchema();

module.exports = mongoose.models.GoalMemory || mongoose.model('GoalMemory', goalMemorySchema, 'goal_memory');