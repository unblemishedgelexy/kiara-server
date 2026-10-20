'use strict';

const mongoose = require('mongoose');
const { MEMORY_TYPES } = require('../services/memory/domain/MemoryType');
const { MEMORY_STATUSES } = require('../services/memory/domain/MemoryStatus');
const { MEMORY_SOURCE_TYPES } = require('../services/memory/domain/MemorySource');
const { MEMORY_RELATION_TYPES } = require('../services/memory/domain/MemoryRelation');

const memorySourceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: MEMORY_SOURCE_TYPES,
      default: 'CONVERSATION',
      required: true,
    },
    reference: { type: String, default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const memorySignalSchema = new mongoose.Schema(
  {
    value: { type: Number, default: 0.5, min: 0, max: 1 },
    label: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM' },
  },
  { _id: false }
);

const memoryTemporalSchema = new mongoose.Schema(
  {
    validFrom: { type: Date },
    validUntil: { type: Date },
    lastConfirmedAt: { type: Date },
  },
  { _id: false }
);

const memoryLifecycleSchema = new mongoose.Schema(
  {
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    lastAccessedAt: { type: Date },
    lastConfirmedAt: { type: Date },
  },
  { _id: false }
);

const memoryRelationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: MEMORY_RELATION_TYPES,
      required: true,
    },
    targetMemoryId: { type: String, required: true },
    confidence: { type: Number, default: 0.5, min: 0, max: 1 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const memorySchema = new mongoose.Schema(
  {
    // Domain canonical identifier. MongoDB _id remains the database identity, while `id` is the user-level canonical memory id.
    id: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    type: { type: String, enum: MEMORY_TYPES, required: true, index: true },
    subject: { type: String, default: '' },
    predicate: { type: String, default: '' },
    value: { type: String, default: '' },
    content: { type: String, required: true },
    source: { type: memorySourceSchema, required: true },
    confidence: { type: memorySignalSchema, required: true },
    importance: { type: memorySignalSchema, required: true },
    status: { type: String, enum: MEMORY_STATUSES, default: 'ACTIVE', index: true },
    temporal: { type: memoryTemporalSchema, default: {} },
    lifecycle: { type: memoryLifecycleSchema, default: {} },
    relations: { type: [memoryRelationSchema], default: [] },
    provenance: { type: mongoose.Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    collection: 'memories',
  }
);

// Domain-level retrieval patterns are almost always user-scoped. The composite index keeps userId + type/status queries efficient without over-indexing every field.
memorySchema.index({ userId: 1, id: 1 }, { unique: true });
memorySchema.index({ userId: 1, type: 1 });
memorySchema.index({ userId: 1, status: 1 });
memorySchema.index({ userId: 1, updatedAt: -1 });
memorySchema.index({ userId: 1, 'importance.value': -1 });

module.exports = mongoose.models.Memory || mongoose.model('Memory', memorySchema);
