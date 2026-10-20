'use strict';

const pineconeService = require('../../pineconeService');
const { env } = require('../../../config/env');
const { SemanticIndexContract, SemanticIndexError } = require('./semanticIndexContract');
const { NAMESPACE, namespaceForUser, toVectorId, toVectorMetadata, mapVectorMatch } = require('./semanticIndexMapper');
const { embedMemory } = require('./semanticEmbedding');

const ACTIVE_STATUSES = ['ACTIVE', 'CANDIDATE'];

class PineconeSemanticIndex extends SemanticIndexContract {
  constructor({ getIndex = pineconeService.getIndex, namespace = NAMESPACE } = {}) {
    super();
    this.getIndex = getIndex;
    this.namespace = namespace;
  }

  async _index() {
    const index = await this.getIndex();
    if (!index) {
      throw new SemanticIndexError('Pinecone semantic index is unavailable.');
    }
    return index;
  }

  async upsert(memory, embedding = null) {
    try {
      let embeddingLatencyMs = 0;
      if (!Array.isArray(embedding)) {
        const embedded = await embedMemory(memory);
        embedding = embedded.embedding;
        embeddingLatencyMs = embedded.latencyMs;
      }
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new TypeError('A non-empty embedding is required.');
      }

      const dimension = Number(env.pineconeVectorDimension);
      if (dimension > 0 && embedding.length !== dimension) {
        throw new TypeError(`Embedding dimension ${embedding.length} does not match configured dimension ${dimension}.`);
      }

      const metadata = toVectorMetadata(memory);
      if (metadata.status === 'EXPIRED' || metadata.status === 'ARCHIVED') {
        return this.delete(metadata.userId, metadata.memoryId);
      }

      const index = await this._index();
      await index.upsert({
        records: [{
          id: toVectorId(memory),
          values: embedding,
          metadata,
        }],
        namespace: namespaceForUser(metadata.userId, this.namespace),
      });
      return { upserted: true, id: toVectorId(memory), version: metadata.version, embeddingLatencyMs };
    } catch (error) {
      if (error instanceof SemanticIndexError) throw error;
      throw new SemanticIndexError('Failed to upsert canonical memory vector.', 'SEMANTIC_INFRASTRUCTURE_FAILURE', error);
    }
  }

  async get(userId, memoryId) {
    try {
      const safeUserId = String(userId || '').trim();
      const safeMemoryId = String(memoryId || '').trim();
      if (!safeUserId || !safeMemoryId) throw new TypeError('userId and memoryId are required.');

      const index = await this._index();
      const response = await index.fetch({
        ids: [safeMemoryId],
        namespace: namespaceForUser(safeUserId, this.namespace),
      });
      // Pinecone SDK v2 returns records, not vectors
      const vector = (response && response.records && response.records[safeMemoryId])
        || (response && response.vectors && response.vectors[safeMemoryId]);
      if (!vector || String(vector.metadata && vector.metadata.userId || '') !== safeUserId) {
        return null;
      }

      return mapVectorMatch({ id: safeMemoryId, metadata: vector.metadata, score: 0 });
    } catch (error) {
      if (error instanceof SemanticIndexError) throw error;
      throw new SemanticIndexError('Failed to get canonical memory vector.', 'SEMANTIC_INFRASTRUCTURE_FAILURE', error);
    }
  }

  async delete(userId, memoryId) {
    try {
      const safeUserId = String(userId || '').trim();
      const safeMemoryId = String(memoryId || '').trim();
      if (!safeUserId || !safeMemoryId) throw new TypeError('userId and memoryId are required.');

      const found = await this.get(safeUserId, safeMemoryId);
      if (!found) return { deleted: false };

      const index = await this._index();
      await index.deleteOne({
        id: safeMemoryId,
        namespace: namespaceForUser(safeUserId, this.namespace),
      });
      return { deleted: true };
    } catch (error) {
      if (error instanceof SemanticIndexError) throw error;
      throw new SemanticIndexError('Failed to delete canonical memory vector.', 'SEMANTIC_INFRASTRUCTURE_FAILURE', error);
    }
  }

  async deleteUserNamespace(userId) {
    const safeUserId = String(userId || '').trim();
    if (!safeUserId) {
      throw new SemanticIndexError('A user is required to delete a semantic namespace.');
    }

    const namespace = namespaceForUser(safeUserId, this.namespace);
    try {
      const index = await this._index();
      try {
        await index.deleteNamespace(namespace);
        return { deleted: true, mode: 'namespace' };
      } catch (namespaceError) {
        if (
          typeof index.listPaginated !== 'function'
          || typeof index.deleteMany !== 'function'
        ) {
          throw namespaceError;
        }

        const ids = [];
        let paginationToken;
        do {
          const page = await index.listPaginated({
            namespace,
            limit: 100,
            ...(paginationToken ? { paginationToken } : {}),
          });
          for (const vector of page.vectors || []) {
            if (typeof vector?.id === 'string' && vector.id) ids.push(vector.id);
          }
          paginationToken = page.pagination?.next;
        } while (paginationToken);

        for (let offset = 0; offset < ids.length; offset += 100) {
          await index.deleteMany({
            ids: ids.slice(offset, offset + 100),
            namespace,
          });
        }

        return { deleted: true, mode: 'listed_ids', count: ids.length };
      }
    } catch (error) {
      if (error instanceof SemanticIndexError) throw error;
      throw new SemanticIndexError('Failed to delete the user-scoped semantic namespace.', 'SEMANTIC_INFRASTRUCTURE_FAILURE', error);
    }
  }

  async query(userId, embedding, options = {}) {
    try {
      const safeUserId = String(userId || '').trim();
      if (!safeUserId) throw new TypeError('userId is required.');
      if (!Array.isArray(embedding) || embedding.length === 0) throw new TypeError('A non-empty query embedding is required.');

      const statusFilter = options.includeSuperseded
        ? { $in: [...ACTIVE_STATUSES, 'SUPERSEDED'] }
        : { $in: ACTIVE_STATUSES };
      const requestedTypes = Array.isArray(options.types)
        ? options.types.map((type) => String(type).toLowerCase()).filter(Boolean)
        : [];
      const index = await this._index();
      const response = await index.query({
        vector: embedding,
        topK: Math.min(Math.max(Number(options.topK) || 10, 1), 50),
        includeMetadata: true,
        includeValues: false,
        namespace: namespaceForUser(safeUserId, this.namespace),
        filter: {
          userId: { $eq: safeUserId },
          status: statusFilter,
          ...(requestedTypes.length > 1 ? { type: { $in: requestedTypes } } : {}),
          ...(requestedTypes.length === 1 ? { type: { $eq: requestedTypes[0] } } : {}),
          ...(options.type ? { type: { $eq: String(options.type).toLowerCase() } } : {}),
        },
      });

      const matches = (Array.isArray(response && response.matches) ? response.matches : [])
        .map(mapVectorMatch)
        .filter((match) => match.memoryId && match.userId === safeUserId);
      return {
        status: matches.length ? 'OK' : 'SEMANTIC_NO_MATCH',
        matches,
      };
    } catch (error) {
      if (error instanceof SemanticIndexError) throw error;
      throw new SemanticIndexError('Failed to query canonical memory vectors.', 'SEMANTIC_INFRASTRUCTURE_FAILURE', error);
    }
  }
}

module.exports = {
  PineconeSemanticIndex,
};
