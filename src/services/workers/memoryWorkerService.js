const memoryJobService = require('../memory/memoryJobService');
const memoryExtractor = require('../memory/memoryExtractorService');
const memoryFilterService = require('../memory/memoryFilterService');
const memoryImportanceService = require('../memory/memoryImportanceService');
const memoryStorageService = require('../memory/memoryStorageService');
const memoryProfileService = require('../memory/memoryProfileService');
const sessionBootstrapService = require('../memory/sessionBootstrapService');
const unfinishedContextService = require('../memory/unfinishedContextService');
const pineconeService = require('../pineconeService');
const memoryMetricsService = require('../memory/memoryMetricsService');
const { env } = require('../../config/env');

const DEEP_MEMORY_CATEGORIES = ['identity', 'project', 'goal', 'relationship', 'fact'];

function createTextEmbedding(text, dimension = env.pineconeVectorDimension || 1536) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const vector = new Array(dimension).fill(0);
  for (let i = 0; i < normalized.length; i += 1) {
    const charCode = normalized.charCodeAt(i);
    vector[i % dimension] += ((charCode % 31) + 1) * 0.1;
  }
  const magnitude = Math.hypot(...vector) || 1;
  return vector.map((value) => value / magnitude);
}

async function processJob(job) {
  if (!job || !job.userId || !job.message) {
    throw new Error('Invalid job payload');
  }

  const extracted = memoryExtractor.extractAll(job.message);
  const filteredExtracted = memoryFilterService.filterExtractedMemories(extracted, job.message);

  if (extracted.length > filteredExtracted.length) {
    await memoryMetricsService.incrementFilteredMemoryCount(job.userId, extracted.length - filteredExtracted.length).catch(() => null);
  }

  const results = [];
  for (const memoryItem of filteredExtracted) {
    const importanceScore = memoryImportanceService.calculateImportance({
      category: memoryItem.category,
      memory: memoryItem.memory,
      lastAccessed: null,
      accessCount: 0,
      userMessage: job.message,
    });

    const saved = await memoryStorageService.saveMemory({
      userId: job.userId,
      category: memoryItem.category,
      memory: memoryItem.memory,
      tags: memoryItem.tags || [],
      importanceScore,
      source: 'queue',
    });

    if (pineconeService.isPineconeConfigured() && DEEP_MEMORY_CATEGORIES.includes(saved.category)) {
      const vector = createTextEmbedding(memoryItem.memory);
      const metadata = {
        userId: job.userId,
        category: saved.category,
        importanceScore: saved.importanceScore,
        tags: saved.tags,
        contentPreview: memoryItem.memory.slice(0, 256),
      };
      try {
        await pineconeService.upsertLongTermVector({ id: String(saved._id), vector, metadata });
      } catch (error) {
        console.warn('Pinecone sync failed:', error);
      }
    }

    results.push(saved);
  }

  await memoryProfileService.rebuildMemoryProfile(job.userId);
  await sessionBootstrapService.buildSessionBootstrapContext(job.userId);
  await unfinishedContextService.syncUnfinishedContexts(job.userId, job.message, extracted);

  return results;
}

async function processMemoryJobs(limit = 10) {
  const jobs = [];
  for (let i = 0; i < limit; i += 1) {
    const job = await memoryJobService.fetchPendingJob();
    if (!job) break;
    jobs.push(job);
  }

  for (const job of jobs) {
    try {
      await processJob(job);
      await memoryJobService.markJobCompleted(job._id);
    } catch (error) {
      await memoryJobService.markJobFailed(job._id, error.message);
    }
  }

  return { processed: jobs.length };
}

async function retryFailedJobs(maxAttempts = 3) {
  return memoryJobService.retryFailedJobs(maxAttempts);
}

async function cleanupOldJobs(days = 30) {
  return memoryJobService.cleanupOldJobs(days);
}

module.exports = {
  processMemoryJobs,
  retryFailedJobs,
  cleanupOldJobs,
};