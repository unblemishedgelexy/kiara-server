'use strict';

/**
 * Strict Retriever
 * - Behaves like a search engine: returns only the top 1-3 most relevant memories
 * - Returns concise bullet lines suitable for direct injection
 * - Never returns full conversation dumps or all facts
 */

const retriever = require('./retriever');
const logger = require('../utils/memoryLogger');

async function searchStrict(userId, query, maxResults = 3) {
  if (!userId || !query || !String(query).trim()) return [];

  try {
    const { analysis, results } = await retriever.retrieve({ userId, query, topK: 8 });

    if (!Array.isArray(results) || results.length === 0) {
      logger.log('STRICT_RETRIEVER', { userId, query: String(query).slice(0, 120), returned: 0 });
      return [];
    }

    // Sort by finalScore (already sorted upstream but be defensive)
    const sorted = results.slice().sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

    const chosen = [];
    for (const r of sorted) {
      if (chosen.length >= maxResults) break;
      const meta = r.metadata || r.raw?.metadata || {};
      let summary = '';
      if (meta && typeof meta.summary === 'string' && meta.summary.trim()) summary = meta.summary.trim();
      else if (meta && typeof meta.value === 'string' && meta.value.trim()) summary = meta.value.trim();
      else if (meta && typeof meta.title === 'string' && meta.title.trim()) summary = meta.title.trim();
      else if (r.raw && r.raw.metadata && typeof r.raw.metadata.summary === 'string') summary = r.raw.metadata.summary.trim();
      else if (r.raw && r.raw.metadata && typeof r.raw.metadata.value === 'string') summary = r.raw.metadata.value.trim();
      else if (r.raw && r.raw.text) summary = String(r.raw.text).slice(0, 300);

      // Fallback to an id-based short line if no summary
      const line = summary || `Memory: ${String(r.id || (r.raw && r.raw.id) || '').slice(0, 60)}`;

      // Ensure the line is concise
      const concise = line.length > 800 ? line.slice(0, 800) + '...' : line;

      chosen.push({ id: r.id || r.raw?.id || null, score: r.finalScore || 0, text: concise });
    }

    // Format as simple bullet lines for injection
    const bullets = chosen.map((c) => `• ${c.text}`);

    logger.log('STRICT_RETRIEVER', { userId, query: String(query).slice(0, 120), returned: bullets.length, ts: new Date().toISOString() });
    return bullets;
  } catch (err) {
    logger.logError('STRICT_RETRIEVER_ERROR', err, { userId, query: String(query).slice(0, 120) });
    return [];
  }
}

module.exports = { searchStrict };
