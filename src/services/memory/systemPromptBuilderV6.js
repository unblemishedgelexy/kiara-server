const sacredMemoryService = require('./sacredMemoryService');
const relationshipMemoryEngine = require('./relationshipMemoryEngine');
const activeContextService = require('./activeContextService');
const followUpMemoryService = require('./followUpMemoryService');
const { ensureUserId } = require('../../utils/ensureUserId');

async function buildV6SystemPrompt(userId, sessionId, options = {}) {
  ensureUserId(userId);

  const tokenBudget = options.tokenBudget || 500;
  const maxTokens = 700; // Never exceed

  try {
    // Build compact identity summary
    const identity = await sacredMemoryService.getSacredMemoriesByCategory(userId, 'identity').catch(() => []);
    const identitySummary = identity
      .slice(0, 1)
      .map((m) => m.content)
      .join('. ');

    // Build relationship summary
    const relationshipSummary = await relationshipMemoryEngine.getRelationshipSummary(userId).catch(() => ({}));
    const relSummary = [
      relationshipSummary.family?.slice(0, 2).join(', '),
      relationshipSummary.friends?.slice(0, 3).join(', '),
    ]
      .filter(Boolean)
      .join('. ');

    // Get active context
    const context = await activeContextService.getContext(userId, sessionId).catch(() => null);

    // Get pending follow-ups
    const followUps = await followUpMemoryService.getPendingFollowUps(userId).catch(() => []);
    const pendingItems = followUps
      .slice(0, 2)
      .map((f) => f.topic)
      .join(', ');

    // Build compact prompt
    const parts = [];
    parts.push('You are Kiara, an AI companion.');

    if (identitySummary) {
      parts.push(`About me: ${identitySummary}`);
    }

    if (relSummary) {
      parts.push(`Important people: ${relSummary}`);
    }

    if (context?.currentTopic) {
      parts.push(`Currently discussing: ${context.currentTopic}`);
    }

    if (context?.currentGoal) {
      parts.push(`Current goal: ${context.currentGoal}`);
    }

    if (pendingItems) {
      parts.push(`To follow up: ${pendingItems}`);
    }

    const systemPrompt = parts.join('\n');
    const estimatedTokens = Math.ceil(systemPrompt.length / 4);

    if (estimatedTokens > maxTokens) {
      // Trim if necessary
      const available = Math.ceil((maxTokens * 4) / parts.length);
      const trimmed = parts.map((p) => (p.length > available ? p.substring(0, available - 3) + '...' : p)).join('\n');
      return {
        systemPrompt: trimmed,
        tokenCount: maxTokens,
        source: 'v6_trimmed',
        components: parts.length,
      };
    }

    return {
      systemPrompt,
      tokenCount: estimatedTokens,
      source: 'v6',
      components: parts.length,
    };
  } catch (err) {
    console.error('Error building V6 system prompt:', err);
    return {
      systemPrompt: 'You are Kiara, an AI companion.',
      tokenCount: 12,
      source: 'v6_fallback',
      error: err.message,
    };
  }
}

module.exports = {
  buildV6SystemPrompt,
};
