'use strict';

const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const redisService = require('../../infrastructure/redisService');
const pineconeService = require('../../pineconeService');
const logger = require('../utils/memoryLogger');

async function consolidateUser(userId, { limitEpisodes = 200 } = {}) {
  const startedAt = Date.now();
  logger.log('CONSOLIDATION_START', { userId, ts: new Date().toISOString() });
  const summary = { userId, mergedFacts: 0, mergedRelationships: 0, linkedEpisodes: 0, archived: 0, updatedStats: 0 };

  try {
    // Load semantic memories and relationships
    const semantic = await WorkingMemoryRedis.getSemanticMemories(userId);
    const relationships = await WorkingMemoryRedis.getRelationships(userId);

    // 1) Merge semantic duplicates across categories by canonical key (category:key:value)
    const merged = {};
    for (const [category, items] of Object.entries(semantic || {})) {
      merged[category] = merged[category] || [];
      const seen = new Map();
      for (const it of items || []) {
        const key = `${it.key}:${String(it.value || '').toLowerCase()}`;
        if (seen.has(key)) {
          const existing = seen.get(key);
          // keep highest confidence / importance / newest
          const existingScore = (Number(existing.confidenceScore || existing.confidence || 0) + Number(existing.importance || 0));
          const newScore = (Number(it.confidenceScore || it.confidence || 0) + Number(it.importance || 0));
          if (newScore > existingScore) {
            seen.set(key, it);
          }
        } else {
          seen.set(key, it);
        }
      }
      for (const v of seen.values()) merged[category].push(v);
      summary.mergedFacts += ((items || []).length - merged[category].length);
    }

    // Write back merged semantic memories
    try {
      await WorkingMemoryRedis.upsertSemanticMemories(userId, merged);
      logger.log('CONSOLIDATION_SEMANTIC_MERGED', { userId, mergedCounts: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v.length])) });
    } catch (e) {
      logger.logError('CONSOLIDATION_SEMANTIC_WRITE_ERROR', e, { userId });
    }

    // 2) Merge duplicate relationships (case-insensitive names)
    const rels = relationships || {};
    const normalized = {};
    for (const [name, r] of Object.entries(rels)) {
      const key = String(name || '').trim().toLowerCase();
      if (!key) continue;
      if (!normalized[key]) normalized[key] = Object.assign({}, r, { personName: name });
      else {
        const existing = normalized[key];
        // merge counts and fields
        existing.mentionCount = (Number(existing.mentionCount || 0) + Number(r.mentionCount || 0));
        existing.firstMention = existing.firstMention || r.firstMention;
        existing.lastMention = existing.lastMention && r.lastMention ? (existing.lastMention > r.lastMention ? existing.lastMention : r.lastMention) : (existing.lastMention || r.lastMention);
        existing.importance = Math.max(Number(existing.importance || 0), Number(r.importance || 0));
        existing.confidence = Math.max(Number(existing.confidence || existing.confidenceScore || 0), Number(r.confidence || r.confidenceScore || 0));
        existing.sharedEvents = Array.from(new Set([...(existing.sharedEvents || []), ...(r.sharedEvents || [])]));
        existing.projects = Array.from(new Set([...(existing.projects || []), ...(r.projects || [])]));
        existing.relationshipStrength = Math.min(1, (Number(existing.relationshipStrength || 0) + Number(r.relationshipStrength || 0)));
        normalized[key] = existing;
        summary.mergedRelationships += 1;
        // mark old as archived in-place (don't delete)
        try {
          await WorkingMemoryRedis.upsertRelationship(userId, name, Object.assign({}, r, { archived: true }));
        } catch {}
      }
    }

    // Upsert normalized relationships under canonical casing (use title-case)
    for (const [key, r] of Object.entries(normalized)) {
      const canonical = (r.personName && String(r.personName).trim()) || key.split(' ').map((s) => s[0]?.toUpperCase() + s.slice(1)).join(' ');
      await WorkingMemoryRedis.upsertRelationship(userId, canonical, r);
    }
    logger.log('CONSOLIDATION_RELATIONSHIPS_MERGED', { userId, merged: summary.mergedRelationships });

    // 3) Strengthen important memories and increase confidence for repeated facts
    // Iterate memory:stats keys for user's episodes and semantic entries
    // Approach: scan memory stats and boost importance/confidence for items with accessFrequency>threshold
    const statsSummary = { scanned: 0, boosted: 0 };
    const client = await redisService.getRedisClient();
    const scanIter = client.scanIterator({ MATCH: 'memory:stats:*', COUNT: 500 });
    for await (const key of scanIter) {
      if (statsSummary.scanned > 2000) break;
      statsSummary.scanned += 1;
      try {
        const memId = key.replace('memory:stats:', '');
        const stats = await WorkingMemoryRedis.getMemoryStats(memId);
        if (!stats) continue;
        // Skip protected types
        if (['identity', 'relationships', 'goals', 'preferences', 'permanent'].includes(stats.memoryType)) continue;
        const af = Number(stats.accessFrequency || 0);
        const imp = Number(stats.importance || 0);
        const conf = Number(stats.confidence || 0);
        // boost if frequently accessed
        if (af > 3) {
          const impDelta = Math.min(0.05, Math.log(af + 1) / 20);
          const confDelta = Math.min(0.03, Math.log(af + 1) / 40);
          await WorkingMemoryRedis.incrementMemoryAccess(memId, { accessFrequency: 0, importanceDelta: impDelta, confidenceDelta: confDelta });
          statsSummary.boosted += 1;
        }
      } catch (e) {
        logger.logError('CONSOLIDATION_STATS_ERROR', e, { userId });
      }
    }
    summary.updatedStats = statsSummary.boosted;

    // 4) Link related episodes by topic/entity overlap
    try {
      const promotedSetKey = WorkingMemoryRedis.buildPromotedEpisodesKey(userId);
      const client2 = await redisService.getRedisClient();
      const episodeIds = await client2.sMembers(promotedSetKey);
      const limited = (episodeIds || []).slice(0, limitEpisodes);
      if (limited.length > 1) {
        const fetched = await pineconeService.fetchLongTermByIds(limited, 'episodes');
        const metaList = Object.entries(fetched || {}).map(([id, v]) => ({ id, metadata: v.metadata || {} }));
        // For each pair, if topics/entities overlap significantly, add relatedEpisodes field
        for (let i = 0; i < metaList.length; i += 1) {
            for (let j = i + 1; j < metaList.length; j += 1) {
              const a = metaList[i]; const b = metaList[j];
            const ta = new Set((a.metadata.topics || []).map(String));
            const tb = new Set((b.metadata.topics || []).map(String));
            const inter = [...ta].filter((x) => tb.has(x));
            if (inter.length >= 1) {
              // append related id to episode link keys
              const keyA = WorkingMemoryRedis.buildEpisodeLinkKey(a.id);
                const keyB = WorkingMemoryRedis.buildEpisodeLinkKey(b.id);
                const aRelatedRaw = await client2.hGet(keyA, 'related') || '[]';
                const bRelatedRaw = await client2.hGet(keyB, 'related') || '[]';
                const aRelated = Array.isArray(JSON.parse(aRelatedRaw || '[]')) ? JSON.parse(aRelatedRaw || '[]') : [];
                const bRelated = Array.isArray(JSON.parse(bRelatedRaw || '[]')) ? JSON.parse(bRelatedRaw || '[]') : [];
                await client2.hSet(keyA, 'related', JSON.stringify(Array.from(new Set([...aRelated, b.id]))));
                await client2.hSet(keyB, 'related', JSON.stringify(Array.from(new Set([...bRelated, a.id]))));
              summary.linkedEpisodes += 2;
            }
          }
        }
      }
    } catch (e) {
      logger.logError('CONSOLIDATION_EPISODE_LINK_ERROR', e, { userId });
    }

    // 5) Archive obsolete semantic entries if superseded by newer/high-confidence entries
    // Simple rule: if multiple entries for same category:key exist (handled earlier), we consider others archived via upsertSemanticMemories; count archived from difference
    summary.archived = summary.mergedFacts; // approximation

    const durationMs = Date.now() - startedAt;
    logger.log('CONSOLIDATION_SUCCESS', { userId, durationMs, summary });
    return { success: true, summary };
  } catch (err) {
    logger.logError('CONSOLIDATION_FAIL', err, { userId });
    return { success: false, error: String(err) };
  }
}

async function consolidateAll({ maxUsers = 50 } = {}) {
  const startedAt = Date.now();
  logger.log('CONSOLIDATION_ALL_START', { maxUsers, ts: new Date().toISOString() });
  try {
    const client = await redisService.getRedisClient();
    const iter = client.scanIterator({ MATCH: 'memory:promotion:promoted:*', COUNT: 200 });
    const users = [];
    for await (const k of iter) {
      if (users.length >= maxUsers) break;
      const m = k.match(/memory:promotion:promoted:(.*)/);
      if (m && m[1]) users.push(m[1]);
    }
    const results = [];
    for (const u of users) {
      const res = await consolidateUser(u);
      results.push(res);
    }
    const durationMs = Date.now() - startedAt;
    logger.log('CONSOLIDATION_ALL_SUCCESS', { durationMs, processed: users.length });
    return { success: true, processed: users.length, results };
  } catch (err) {
    logger.logError('CONSOLIDATION_ALL_FAIL', err, {});
    return { success: false, error: String(err) };
  }
}

module.exports = { consolidateUser, consolidateAll };
