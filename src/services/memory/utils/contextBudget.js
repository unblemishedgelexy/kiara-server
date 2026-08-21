'use strict';

/**
 * Context Budget Service
 * 
 * Manages memory context size to stay within budget.
 * Ensures only the most relevant memories are included.
 * Implements compression and truncation strategies.
 */

const logger = require('./memoryLogger');

// ────────────────────────────────────────────────────────────────────
// Budget Configuration
// ────────────────────────────────────────────────────────────────────

const DEFAULT_BUDGETS = {
  // Token-based budgets (1 token ≈ 4 characters)
  SHORT_TERM_MEMORY_TOKENS: 800,       // ~3200 chars for recent conversation
  LONG_TERM_MEMORY_TOKENS: 400,        // ~1600 chars for relevant facts
  TOTAL_CONTEXT_TOKENS: 1500,          // ~6000 chars total
  
  // Item-based limits
  MAX_RECENT_TURNS: 10,
  MAX_IDENTITY_FACTS: 3,
  MAX_RELATIONSHIPS: 5,
  MAX_PROJECTS: 2,
  MAX_EPISODES: 8,
  MAX_OTHER_FACTS: 5,
};

// ────────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────────

/**
 * Estimate tokens for text.
 * Simple approximation: 1 token ≈ 4 characters.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Compress a single memory item to reduce token usage.
 */
function compressMemory(memory) {
  if (!memory) return '';

  // Extract most important info
  const type = String(memory.type || memory.category || 'fact').toLowerCase();
  const title = memory.title || memory.key || memory.label || (type === 'identity' ? 'Name' : '');
  const value = memory.value || memory.content || memory.summary || '';

  // Truncate long values
  const truncatedValue = String(value).slice(0, 150);

  if (!title && !truncatedValue) {
    return '';
  }

  if (type === 'identity') {
    return `${title || 'Name'}: ${truncatedValue}`.trim();
  }

  return `${title}${title && truncatedValue ? ': ' : ''}${truncatedValue}`.trim();
}

/**
 * Compress a section of memories (remove duplicates, truncate).
 */
function compressMemorySection(memories, maxItems = 5) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return [];
  }
  
  // Keep only highest relevance/importance
  const sorted = memories
    .filter(m => m)
    .sort((a, b) => {
      const scoreA = Number(a.relevanceScore || a.importance || a.score || 0);
      const scoreB = Number(b.relevanceScore || b.importance || b.score || 0);
      return scoreB - scoreA;
    })
    .slice(0, maxItems);
  
  return sorted;
}

// ────────────────────────────────────────────────────────────────────
// Context Assembly
// ────────────────────────────────────────────────────────────────────

/**
 * Build context respecting token budget.
 * Returns formatted sections with total token count.
 */
function buildBudgetedContext(contextData, budgets = {}) {
  const finalBudgets = { ...DEFAULT_BUDGETS, ...budgets };
  
  const sections = [];
  let totalTokens = 0;
  const startTime = Date.now();
  
  // 1. Identity facts (high priority)
  if (contextData.identity && Array.isArray(contextData.identity)) {
    const compressed = compressMemorySection(contextData.identity, finalBudgets.MAX_IDENTITY_FACTS);
    if (compressed.length > 0) {
      const identityLines = compressed.map(item => `• ${compressMemory(item)}`);
      const identityText = `Identity:\n${identityLines.join('\n')}`;
      const tokens = estimateTokens(identityText);
      
      if (totalTokens + tokens <= finalBudgets.TOTAL_CONTEXT_TOKENS) {
        sections.push(identityText);
        totalTokens += tokens;
      }
    }
  }
  
  // 2. Current goal/project (medium priority)
  if (contextData.activeProject) {
    const projectText = `Active Project: ${compressMemory(contextData.activeProject)}`;
    const tokens = estimateTokens(projectText);
    
    if (totalTokens + tokens <= finalBudgets.TOTAL_CONTEXT_TOKENS) {
      sections.push(projectText);
      totalTokens += tokens;
    }
  }
  
  // 3. Relationships (medium priority)
  if (contextData.relationships && Array.isArray(contextData.relationships)) {
    const compressed = compressMemorySection(contextData.relationships, finalBudgets.MAX_RELATIONSHIPS);
    if (compressed.length > 0) {
      const relLines = compressed.map(item => `• ${compressMemory(item)}`);
      const relText = `Key Relationships:\n${relLines.join('\n')}`;
      const tokens = estimateTokens(relText);
      
      if (totalTokens + tokens <= finalBudgets.TOTAL_CONTEXT_TOKENS) {
        sections.push(relText);
        totalTokens += tokens;
      }
    }
  }
  
  // 4. Relevant episodes/memories (medium priority)
  if (contextData.episodes && Array.isArray(contextData.episodes)) {
    const compressed = compressMemorySection(contextData.episodes, finalBudgets.MAX_EPISODES);
    if (compressed.length > 0) {
      const epLines = compressed.map(item => `• ${compressMemory(item)}`);
      const epText = `Relevant Context:\n${epLines.join('\n')}`;
      const tokens = estimateTokens(epText);
      
      if (totalTokens + tokens <= finalBudgets.TOTAL_CONTEXT_TOKENS) {
        sections.push(epText);
        totalTokens += tokens;
      }
    }
  }
  
  // 5. Preferences (low priority)
  if (contextData.preferences && Array.isArray(contextData.preferences)) {
    const compressed = compressMemorySection(contextData.preferences, 2);
    if (compressed.length > 0) {
      const prefLines = compressed.map(item => `• ${compressMemory(item)}`);
      const prefText = `Preferences:\n${prefLines.join('\n')}`;
      const tokens = estimateTokens(prefText);
      
      if (totalTokens + tokens <= finalBudgets.TOTAL_CONTEXT_TOKENS) {
        sections.push(prefText);
        totalTokens += tokens;
      }
    }
  }
  
  // 6. Recent conversation turns (kept within budget)
  if (contextData.recentTurns && Array.isArray(contextData.recentTurns)) {
    const remainingBudget = finalBudgets.SHORT_TERM_MEMORY_TOKENS;
    const turnLines = [];
    let turnTokens = 0;
    
    for (const turn of contextData.recentTurns.slice(0, finalBudgets.MAX_RECENT_TURNS)) {
      const turnText = `U: ${turn.userMessage || ''}\nK: ${turn.aiResponse || turn.assistantResponse || ''}\n`;
      const tokens = estimateTokens(turnText);
      
      if (turnTokens + tokens <= remainingBudget && totalTokens + turnTokens + tokens <= finalBudgets.TOTAL_CONTEXT_TOKENS) {
        turnLines.push(turnText);
        turnTokens += tokens;
      } else {
        break;
      }
    }
    
    if (turnLines.length > 0) {
      const turnText = `Recent Conversation:\n${turnLines.join('\n')}`;
      sections.push(turnText);
      totalTokens += turnTokens;
    }
  }
  
  const finalContext = sections.join('\n\n').trim();
  const durationMs = Date.now() - startTime;
  
  logger.log('CONTEXT_BUDGET', {
    totalTokens,
    budgetTokens: finalBudgets.TOTAL_CONTEXT_TOKENS,
    budgetUsagePercent: Math.round((totalTokens / finalBudgets.TOTAL_CONTEXT_TOKENS) * 100),
    sectionCount: sections.length,
    durationMs,
  });
  
  return {
    context: finalContext,
    totalTokens,
    budgetTokens: finalBudgets.TOTAL_CONTEXT_TOKENS,
    budgetUsagePercent: Math.round((totalTokens / finalBudgets.TOTAL_CONTEXT_TOKENS) * 100),
  };
}

/**
 * Truncate context to fit within token budget.
 */
function truncateContext(context, maxTokens = DEFAULT_BUDGETS.TOTAL_CONTEXT_TOKENS) {
  if (!context) return '';
  
  const text = String(context);
  const tokens = estimateTokens(text);
  
  if (tokens <= maxTokens) {
    return text;
  }
  
  // Binary search for largest prefix that fits
  let low = 0;
  let high = text.length;
  let bestLength = 0;
  
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = text.slice(0, mid);
    
    if (estimateTokens(prefix) <= maxTokens) {
      bestLength = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  
  // Trim to last complete sentence/line
  let result = text.slice(0, bestLength);
  const lastNewline = result.lastIndexOf('\n');
  if (lastNewline > 0) {
    result = result.slice(0, lastNewline);
  }
  
  logger.log('CONTEXT_TRUNCATED', {
    originalTokens: tokens,
    truncatedTokens: estimateTokens(result),
    maxTokens,
  });
  
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_BUDGETS,
  
  // Utilities
  estimateTokens,
  compressMemory,
  compressMemorySection,
  
  // Main API
  buildBudgetedContext,
  truncateContext,
};
