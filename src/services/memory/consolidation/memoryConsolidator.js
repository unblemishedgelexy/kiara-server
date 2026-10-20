'use strict';

const { Memory } = require('../domain/Memory');
const { MongoMemoryRepository } = require('../repository/mongoMemoryRepository');
const { RedisMemoryCache } = require('../cache/redisMemoryCache');
const { resolveConflict } = require('./conflictResolver');
const { detectDuplicate } = require('./duplicateDetector');
const {
  sameCanonicalIdentity,
  samePreferenceSlot,
  shouldMergeProject,
} = require('./consolidationPolicy');

class MemoryConsolidator {
  constructor({ repository = null, cache = null } = {}) {
    this.repository = repository || new MongoMemoryRepository();
    this.cache = cache || new RedisMemoryCache();
  }

  async _findRelevantExistingMemories(userId, candidate, { limit = 25 } = {}) {
    if (!this.repository || typeof this.repository.findActiveByUser !== 'function') {
      return null;
    }

    const active = await this.repository.findActiveByUser(userId, { limit, sort: { updatedAt: -1 } });
    if (!Array.isArray(active) || active.length === 0) {
      return null;
    }

    const normalizedCandidate = candidate && candidate.toJSON ? candidate.toJSON() : candidate;

    const ranked = active.map((memory) => {
      const duplicate = detectDuplicate(memory, normalizedCandidate);
      const sameIdentity = sameCanonicalIdentity(memory, normalizedCandidate);
      const preferenceSlot = samePreferenceSlot(memory, normalizedCandidate);
      const projectIdentity = shouldMergeProject(memory, normalizedCandidate);
      const score = duplicate ? 4
        : (sameIdentity ? 3 : (preferenceSlot ? 2 : (projectIdentity ? 1 : 0)));
      return { memory, score };
    });

    ranked.sort((left, right) => right.score - left.score);
    return ranked.length && ranked[0].score > 0 ? ranked[0].memory : null;
  }

  async _persistDecision(userId, decision, { candidate, existingMemory, replacementMemory, changes } = {}) {
    if (!this.repository) {
      return {
        persisted: false,
        reason: 'No repository is configured for consolidation persistence.',
      };
    }

    let persisted = null;
    let cacheWarning = null;
    let mongoLatencyMs = 0;
    let cacheLatencyMs = 0;
    let mongoStartedAt = 0;

    try {
      mongoStartedAt = Date.now();
      switch (decision) {
        case 'CREATE': {
          persisted = await this.repository.create({
            ...candidate,
            status: 'ACTIVE',
          });
          break;
        }
        case 'UPDATE': {
          persisted = await this.repository.update(userId, existingMemory.id, {
            ...candidate,
            status: 'ACTIVE',
            version: Number(existingMemory.version || 1) + 1,
            expectedVersion: Number(existingMemory.version || 1),
          });
          break;
        }
        case 'MERGE': {
          persisted = await this.repository.update(userId, existingMemory.id, {
            content: [existingMemory.content, candidate.content].filter(Boolean).join(' '),
            value: candidate.value || existingMemory.value,
            subject: candidate.subject || existingMemory.subject,
            predicate: candidate.predicate || existingMemory.predicate,
            metadata: { ...(existingMemory.metadata || {}), ...(candidate.metadata || {}), mergedFrom: existingMemory.id },
            status: 'ACTIVE',
            version: Number(existingMemory.version || 1) + 1,
            expectedVersion: Number(existingMemory.version || 1),
          });
          break;
        }
        case 'SUPERSEDE': {
          persisted = await this.repository.supersede(userId, existingMemory.id, {
            ...candidate,
            id: candidate.id || existingMemory.id,
            status: 'ACTIVE',
            version: Number(existingMemory.version || 1) + 1,
          });
          break;
        }
        case 'COEXIST': {
          persisted = await this.repository.create({
            ...candidate,
            status: 'ACTIVE',
          });
          break;
        }
        default:
          return { persisted: false, reason: 'No persistence required for this decision.' };
      }
      mongoLatencyMs = Date.now() - mongoStartedAt;

      if (this.cache && persisted && typeof this.cache.set === 'function') {
        const cacheStartedAt = Date.now();
        try {
          if (decision === 'SUPERSEDE' && persisted && persisted.replacement) {
            await this.cache.set(persisted.replacement);
            if (existingMemory && existingMemory.id) {
              await this.cache.delete(userId, existingMemory.id);
            }
          } else if (persisted && persisted.toJSON) {
            await this.cache.set(persisted.toJSON());
          } else if (persisted && persisted.id) {
            await this.cache.set(persisted);
          }
        } catch (error) {
          cacheWarning = `Mongo success but Redis cache update failed: ${error.message}`;
        } finally {
          cacheLatencyMs = Date.now() - cacheStartedAt;
        }
      }

      return {
        persisted: true,
        result: persisted,
        cacheWarning,
        mongoLatencyMs,
        cacheLatencyMs,
      };
    } catch (error) {
      return {
        persisted: false,
        error,
        mongoLatencyMs: mongoLatencyMs || (mongoStartedAt ? Date.now() - mongoStartedAt : 0),
        cacheLatencyMs,
      };
    }
  }

  async consolidate({ userId, candidate, options = {} } = {}) {
    if (!userId) {
      throw new Error('userId is required for consolidation.');
    }

    const normalizedCandidate = new Memory(candidate).toJSON();
    const relevantExisting = await this._findRelevantExistingMemories(userId, normalizedCandidate, options);
    const resolution = resolveConflict({ candidate: normalizedCandidate, existingMemory: relevantExisting });

    const base = {
      decision: resolution.decision,
      candidate: normalizedCandidate,
      existingMemory: relevantExisting || null,
      replacementMemory: null,
      reason: resolution.reason,
      changes: resolution.changes || {},
      persisted: false,
    };

    if (resolution.decision === 'DUPLICATE' || resolution.decision === 'IGNORE') {
      return base;
    }

    if (options.dryRun === true) {
      return { ...base, dryRun: true };
    }

    if (resolution.decision === 'SUPERSEDE' && relevantExisting) {
      const replacement = {
        ...normalizedCandidate,
        id: normalizedCandidate.id || `${relevantExisting.id}-replacement`,
        status: 'ACTIVE',
        version: Number(relevantExisting.version || 1) + 1,
      };
      base.replacementMemory = replacement;
    }

    const persisted = await this._persistDecision(userId, resolution.decision, {
      candidate: normalizedCandidate,
      existingMemory: relevantExisting,
      replacementMemory: base.replacementMemory,
      changes: base.changes,
    });

    return {
      ...base,
      ...persisted,
      candidate: normalizedCandidate,
      existingMemory: relevantExisting || null,
      replacementMemory: base.replacementMemory,
      persisted: !!persisted && !!persisted.persisted,
      cacheWarning: persisted && persisted.cacheWarning ? persisted.cacheWarning : null,
    };
  }
}

module.exports = {
  MemoryConsolidator,
};
