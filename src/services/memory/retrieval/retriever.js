'use strict';

/**
 * Retriever wrapper: analyze user query, select namespaces, query Pinecone,
 * rank results with configurable weights, perform multi-hop traversal,
 * merge with STM, and return ranked memories with confidence and relationship hits.
 */

const { computeEmbedding } = require('../../../utils/memory/memoryUtils');
const pineconeService = require('../../pineconeService');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const logger = require('../utils/memoryLogger');
const { env } = require('../../../config/env');

// Default weights (configurable via env)
const WEIGHTS = {
  similarity: Number(env.ltmWeightSimilarity) || 0.4,
  importance: Number(env.ltmWeightImportance) || 0.2,
  relationship: Number(env.ltmWeightRelationship) || 0.15,
  recency: Number(env.ltmWeightRecency) || 0.1,
  frequency: Number(env.ltmWeightFrequency) || 0.1,
  confidence: Number(env.ltmWeightConfidence) || 0.05,
};

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((s, v) => s + (Number(v) || 0), 0) || 1;
  const out = {};
  for (const k of Object.keys(weights)) out[k] = (Number(weights[k]) || 0) / total;
  return out;
}

const normalizedWeights = normalizeWeights(WEIGHTS);

function simpleQueryAnalyzer(text) {
  const q = String(text || '').toLowerCase();
  const intent = {};
  if (/\b(name|mera naam|mera naam kya|mera naam\?)\b/.test(q)) intent.type = 'identity';
  else if (/\b(kal|yesterday|today|last night|aaj|kal kya|kal kya hua)\b/.test(q)) intent.type = 'episode_recall';
  else if (/\b(project|project ke|par kaam|kaam kar)\b/.test(q)) intent.type = 'project_recall';
  else if (/\b(kaun|kaunsi|kis|kiski|kiske)\b/.test(q) && /\b(name|naam|kaun)\b/.test(q)) intent.type = 'identity';
  else intent.type = 'semantic_search';

  // Extract simple person names (capitalized words heuristic) and keywords
  const people = [];
  const personMatches = text.match(/[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g) || [];
  for (const m of personMatches) {
    if (!people.includes(m)) people.push(m);
  }

  // topics: words after 'about' or nouns heuristic
  const topics = [];
  const aboutMatch = text.match(/about\s+([\w\s]+)/i);
  if (aboutMatch) topics.push(aboutMatch[1].trim());

  return { intent: intent.type, people, topics };
}

async function queryNamespaces({ userId, text, topK = 5 }) {
  const analysis = simpleQueryAnalyzer(text);
  logger.log('RETRIEVER_ANALYSIS', { userId, analysis });

  // Decide namespaces by intent
  const allowedNamespaces = [];
  if (analysis.intent === 'identity') {
    allowedNamespaces.push('identity', 'facts');
  } else if (analysis.intent === 'episode_recall') {
    allowedNamespaces.push('episodes');
  } else if (analysis.intent === 'project_recall') {
    allowedNamespaces.push('projects', 'episodes');
  } else {
    // general semantic search: prefer semantic memories and episodes
    allowedNamespaces.push('semantic', 'episodes', 'projects');
  }

  // If specific people mentioned, target relationship namespace
  if (analysis.people && analysis.people.length) allowedNamespaces.unshift('relationships');

  // Remove duplicates and respect configured allowed namespaces
  const uniqueNs = Array.from(new Set(allowedNamespaces)).filter(Boolean);
  logger.log('RETRIEVER_NAMESPACES', { userId, namespaces: uniqueNs });

  // Compute embedding
  const embedding = await computeEmbedding(text);
  if (!embedding) return { analysis, results: [] };

  // Query each namespace with metadata filter where supported
  const matches = [];
  for (const ns of uniqueNs) {
    try {
      // Query Pinecone for the requested namespace
      const queryFilter = ns === 'relationships' ? { relationship: { $exists: true } } : {};
      logger.log('RETRIEVER_QUERY_INTENT', { userId, requestedNamespace: ns, queryNamespace: ns, filter: queryFilter, topK, host: env.pineconeHost || null });
      const raw = await pineconeService.queryLongTermVectors({ vector: embedding, topK, filter: queryFilter, namespace: ns });
      logger.log('RETRIEVER_QUERY_RESULT', { userId, requestedNamespace: ns, queryNamespace: ns, returnedNamespace: ns, returnedCount: Array.isArray(raw) ? raw.length : 0, host: env.pineconeHost || null });
      if (Array.isArray(raw) && raw.length) {
        for (const item of raw) {
          matches.push({ namespace: ns, match: item });
        }
      }
    } catch (err) {
      logger.logError('RETRIEVER_PINECONE_ERROR', err, { userId, namespace: ns });
    }
  }

  // If relationships were explicitly mentioned, fetch related episode ids from Redis and fetch their metadata from Pinecone
  if (analysis.people && analysis.people.length) {
    try {
      const rels = await WorkingMemoryRedis.getRelationships(userId);
      for (const person of analysis.people) {
        const p = rels[person] || null;
        if (p && Array.isArray(p.sharedEvents) && p.sharedEvents.length) {
          const ids = p.sharedEvents.slice(0, topK);
          const fetched = await pineconeService.fetchLongTermByIds(ids, 'episodes');
          for (const id of Object.keys(fetched || {})) {
            const vec = fetched[id];
            matches.push({ namespace: 'episodes', match: { id, metadata: vec.metadata, score: 1.0 } });
          }
        }
      }
      logger.log('RETRIEVER_RELATION_MATCHES', { userId, people: analysis.people, added: matches.length });
    } catch (err) {
      logger.logError('RETRIEVER_RELATIONSHIP_TRAVERSAL_ERROR', err, { userId, people: analysis.people });
    }
  }

  logger.log('RETRIEVER_RAW_MATCHES', { userId, count: matches.length });
  return { analysis, matches };
}

function computeRecencyScore(metadata) {
  try {
    const ts = Number(metadata?.timelineEnd || metadata?.updatedAt || 0) || 0;
    if (!ts) return 0;
    const ageMs = Date.now() - Number(new Date(String(ts)).getTime());
    // recent -> higher score; decay over 365 days
    const days = Math.max(1, ageMs / (1000 * 60 * 60 * 24));
    return Math.max(0, 1 - Math.min(days / 365, 1));
  } catch (_) { return 0; }
}

function computeFrequencyScore(metadata) {
  return Number(metadata?.accessFrequency || 0) > 0 ? Math.tanh(Number(metadata.accessFrequency) / 10) : 0;
}

function computeRelationshipScore(metadata, analysis) {
  // If person matches or relationship strength in metadata
  const rel = Number(metadata?.relationshipStrength || 0) || 0;
  // Boost if analysis.people mentions the person name in metadata
  let boost = 0;
  if (analysis.people && analysis.people.length && metadata?.people) {
    for (const p of analysis.people) {
      if (String(metadata.people).includes(p)) boost = Math.max(boost, 0.2);
    }
  }
  return Math.min(1, rel + boost);
}

function computeImportanceScore(metadata) {
  return Number(metadata?.importance || 0) || 0;
}

function computeConfidence(metadata) {
  return Number(metadata?.confidenceScore || metadata?.confidence || 0) || 0;
}

function scoreMatch(item, analysis) {
  const m = item.match;
  const meta = m?.metadata || {};
  const similarity = Number(m?.score || 0) || 0; // best-effort; Pinecone match may include "score"
  const importance = computeImportanceScore(meta);
  const relationship = computeRelationshipScore(meta, analysis);
  const recency = computeRecencyScore(meta);
  const frequency = computeFrequencyScore(meta);
  const confidence = computeConfidence(meta);

  const s = normalizedWeights.similarity * similarity
    + normalizedWeights.importance * importance
    + normalizedWeights.relationship * relationship
    + normalizedWeights.recency * recency
    + normalizedWeights.frequency * frequency
    + normalizedWeights.confidence * confidence;

  return { finalScore: s, components: { similarity, importance, relationship, recency, frequency, confidence }, metadata: meta };
}

function mergeDuplicates(existing, incoming) {
  // prefer newer, higher confidence, higher importance
  if (!existing) return incoming;
  const e = existing; const i = incoming;
  const pick = (a, b, key) => (Number(a.metadata[key] || 0) >= Number(b.metadata[key] || 0) ? a : b);
  // compare confidence then updatedAt
  const eConf = Number(e.metadata.confidenceScore || e.metadata.confidence || 0);
  const iConf = Number(i.metadata.confidenceScore || i.metadata.confidence || 0);
  if (iConf !== eConf) return iConf > eConf ? i : e;
  const eTs = Number(e.metadata.updatedAt || 0) || 0;
  const iTs = Number(i.metadata.updatedAt || 0) || 0;
  return iTs > eTs ? i : e;
}

async function retrieve({ userId, query, topK = 6 }) {
  // Analyze and query
  const { analysis, matches } = await queryNamespaces({ userId, text: query, topK });

  // Score matches
  // enrich matches with memory stats from Redis for reinforcement-aware scoring
  const scored = [];
  for (const it of matches) {
    try {
      const memId = it.match?.id || (it.match?.metadata && it.match.metadata.memoryId) || null;
      const stats = memId ? await WorkingMemoryRedis.getMemoryStats(memId) : null;
      const scoredItem = Object.assign({ namespace: it.namespace, id: memId, raw: it.match }, scoreMatch(it, analysis));
      if (stats) {
        scoredItem.components.importance = Math.max(scoredItem.components.importance, stats.importance || 0);
        scoredItem.components.confidence = Math.max(scoredItem.components.confidence, stats.confidence || 0);
        scoredItem.finalScore = scoredItem.finalScore + ((stats.retrievalPriority || 0) * normalizedWeights.importance);
        scoredItem.stats = stats;
      }
      scored.push(scoredItem);
    } catch (err) {
      logger.logError('RETRIEVER_SCORE_ENRICH_ERROR', err, { userId, match: it });
    }
  }

  // Merge duplicates by id or similar text
  const byId = new Map();
  for (const s of scored) {
    const key = s.id || (s.raw?.metadata && s.raw.metadata.memoryId) || JSON.stringify(s.raw?.metadata || {});
    const existing = byId.get(key);
    if (existing) {
      byId.set(key, mergeDuplicates(existing, s));
    } else {
      byId.set(key, s);
    }
  }

  const deduped = Array.from(byId.values());
  // Sort by finalScore desc
  deduped.sort((a, b) => b.finalScore - a.finalScore);

  logger.log('RETRIEVER_RESULTS', { userId, query: String(query).slice(0, 120), requestedTopK: topK, returned: deduped.length });
  // Reinforcement: slightly increase stats for returned memories
  try {
    for (const r of deduped.slice(0, Math.max(1, Math.floor(topK / 2)))) {
      const memoryId = r.id;
      if (!memoryId) continue;
      await WorkingMemoryRedis.incrementMemoryAccess(memoryId, { accessFrequency: 1, importanceDelta: 0.002, confidenceDelta: 0.001 });
      logger.log('MEMORY_REINFORCED', { userId, memoryId });
    }
  } catch (e) {
    logger.logError('RETRIEVER_REINFORCEMENT_ERROR', e, { userId });
  }
  return { analysis, results: deduped };
}

module.exports = { retrieve, simpleQueryAnalyzer, normalizeWeights };
