'use strict';

/**
 * Prompt Builder — Phase 6
 *
 * Constructs a structured Gemini-ready context string from:
 *   - Ranked structured facts (Known Facts)
 *   - Current task state
 *   - Recent conversation turns (capped)
 *
 * Gemini NEVER receives raw Redis conversation dumps.
 * It receives a clean, structured, human-readable summary.
 *
 * Private module — only memory.service.js imports this.
 */

const logger = require('../utils/memoryLogger');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');

// ─────────────────────────────────────────────
// Section labels
// ─────────────────────────────────────────────
const SECTION = Object.freeze({
  FACTS:   '=== Known Facts ===',
  TASK:    '=== Current Task ===',
  RECENT:  '=== Recent Conversation ===',
  RECALL:  '=== Direct Answer ===',
});

// The prompt builder no longer imposes fixed turn or character caps;
// the retrieval layer supplies a pre-filtered set of complete turns
// that already respects the configured character budget.

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Group facts by category.
 * @param {Object[]} facts
 * @returns {Map<string, Object[]>}
 */
/**
 * Build the Known Facts section.
 * @param {Object[]} facts
 * @returns {string}
 */
function buildFactsSection(facts, seenKeys) {
  if (!facts) return '';
  const lines = [];
  // facts is an object grouping by category
  for (const [category, items] of Object.entries(facts)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    const header = `=== ${category.toUpperCase()} ===`;
    const groupLines = [];
    for (const it of items) {
      const key = `${category}:${it.key}:${String(it.value || '').toLowerCase()}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const value = String(it.value || '').trim();
      if (!value) continue;
      groupLines.push(`${it.label || it.key}: ${value}`);
    }
    if (groupLines.length) {
      lines.push(header);
      lines.push(...groupLines);
    }
  }
  return lines.join('\n');
}

/**
 * Build the Current Task section.
 * @param {Object|null} task
 * @returns {string}
 */
function buildTaskSection(task) {
  if (!task) return '';
  return `=== Current Task ===\n${task.title || task.goal || JSON.stringify(task).slice(0, 300)}`;
}

/**
 * Build the Recent Conversation section.
 * Takes the most recent N turns, newest last.
 * @param {Object[]} turns  - array of { userMessage, aiResponse } objects
 * @returns {string}
 */
function buildRecentSection(turns) {
  if (!turns || turns.length === 0) return '';
  const lines = [];

  for (const turn of turns) {
    const timestamp = String(turn.timestamp || '').trim();
    const user = String(turn.userMessage || turn.user || '').trim();
    const assistant = String(turn.aiResponse || turn.assistantResponse || turn.assistantMessage || '').trim();

    if (!timestamp || !user || !assistant) {
      continue;
    }

    lines.push(`T:${timestamp}`);
    lines.push(`U:${user}`);
    lines.push(`K:${assistant}`);
  }

  return lines.join('\n');
}

/**
 * Build a direct recall answer section (when user asks "what's my name?" etc.)
 * @param {Object|null} bestMatch - single fact
 * @returns {string}
 */
function buildRecallSection(bestMatch) {
  if (!bestMatch) return '';
  return `=== Direct Recall ===\n${bestMatch.metadata?.summary || bestMatch.metadata?.value || bestMatch.raw?.metadata?.summary || bestMatch.raw?.metadata?.value || ''}`;
}

function buildIdentitySection(identityItems, seenKeys) {
  if (!identityItems || !identityItems.length) return '';
  const lines = ['=== Identity ==='];
  for (const it of identityItems) {
    const k = `identity:${it.key}:${String(it.value || '').toLowerCase()}`;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    lines.push(`${it.label || it.key}: ${it.value}`);
  }
  return lines.join('\n');
}

function buildRelationshipSection(relationships, seenKeys, limit = 8) {
  if (!relationships) return '';
  const lines = ['=== Relationships ==='];
  const arr = Object.values(relationships || {}).filter(Boolean);
  arr.sort((a, b) => (Number(b.mentionCount || 0) + Number(b.relationshipStrength || 0)) - (Number(a.mentionCount || 0) + Number(a.relationshipStrength || 0)));
  let count = 0;
  for (const r of arr) {
    if (count >= limit) break;
    const k = `rel:${String(r.personName || '').toLowerCase()}`;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    lines.push(`${r.personName}: ${r.relationshipType || 'contact'} (mentions:${r.mentionCount || 0}, strength:${Number(r.relationshipStrength || 0).toFixed(2)})`);
    count += 1;
  }
  if (lines.length === 1) return '';
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Build the complete context string for Gemini.
 *
 * @param {Object} options
 * @param {string}   options.userId
 * @param {Object[]} options.facts        - ranked structured facts
 * @param {Object|null} options.task      - current task
 * @param {Object[]} options.recentTurns  - recent conversation turns
 * @param {Object|null} [options.recallMatch] - direct recall match (optional)
 * @returns {string} formatted prompt context
 */
function buildContext({ userId, facts = [], task = null, recentTurns = [], recallMatch = null, identity = [], relationships = {}, goal = null, activeProject = null, preferences = [], episodes = [] } = {}) {
  const startedAt = Date.now();
  const seenKeys = new Set();
  logger.logPromptBuilder(userId, { status: 'started', turnCount: Array.isArray(recentTurns) ? recentTurns.length : 0 });

  const sections = [];

  // Identity
  const identitySection = buildIdentitySection(identity, seenKeys);
  if (identitySection) sections.push(identitySection);

  // Relationships
  const relationshipSection = buildRelationshipSection(relationships, seenKeys);
  if (relationshipSection) sections.push(relationshipSection);

  // Current Goal
  const taskSection = buildTaskSection(goal || task);
  if (taskSection) sections.push(taskSection);

  // Active Project
  if (activeProject) {
    const ap = activeProject;
    const apKey = `project:${String(ap.key || ap.value || ap.id || ap.title || '').toLowerCase()}`;
    if (!seenKeys.has(apKey)) {
      seenKeys.add(apKey);
      sections.push(`=== Active Project ===\n${ap.title || ap.value || JSON.stringify(ap).slice(0, 300)}`);
    }
  }

  // Preferences
  const prefSection = buildFactsSection({ preferences }, seenKeys);
  if (prefSection) sections.push(prefSection);

  // Long Term Facts
  const factsSection = buildFactsSection(facts, seenKeys);
  if (factsSection) sections.push(factsSection);

  // Relationship-first episodes: if recallMatch or episodes reference relationships, prefer relationship summaries first
  const relFirst = [];
  const others = [];
  for (const ep of episodes) {
    const meta = ep.metadata || {};
    const refPeople = (meta.people || meta.entities || []).map(String);
    const intersectsRel = refPeople.some((p) => Object.keys(relationships || {}).includes(p));
    if (intersectsRel) relFirst.push(ep); else others.push(ep);
  }

  function formatEpisode(ep) {
    const ts = ep.metadata?.timelineEnd || ep.metadata?.updatedAt || '';
    const lines = [`- Episode: ${ep.metadata?.title || ep.id || ''}`];
    if (ep.metadata?.summary) lines.push(`  Summary: ${ep.metadata.summary}`);
    if (ts) lines.push(`  When: ${new Date(String(ts)).toISOString()}`);
    return lines.join('\n');
  }

  const episodeLines = [];
  if (relFirst.length) {
    episodeLines.push('=== Relevant Episodes (Relationships First) ===');
    for (const ep of relFirst.slice(0, 6)) episodeLines.push(formatEpisode(ep));
  }
  if (others.length) {
    episodeLines.push('=== Relevant Episodes ===');
    for (const ep of others.slice(0, 12)) episodeLines.push(formatEpisode(ep));
  }
  if (episodeLines.length) sections.push(episodeLines.join('\n'));

  // Recent STM
  const recentSection = buildRecentSection(recentTurns);
  if (recentSection) sections.push('=== Recent Conversation ===\n' + recentSection);

  // Final assembly and dedupe already handled by seenKeys
  const context = sections.join('\n\n').trim();

  logger.logPromptBuilder(userId, { status: 'finished', durationMs: Date.now() - startedAt, contextLength: context.length, sectionCount: sections.length });
  logger.logFinalContext(userId, context);
  logger.log('CONTEXT_BUILD', { userId, sectionCount: sections.length, finalLength: context.length, ts: new Date().toISOString() });

  // Token estimate
  const tokens = Math.ceil(context.length / 4);
  logger.log('CONTEXT_TOKENS', { userId, tokens, chars: context.length });

  return context;
}

module.exports = { buildContext };
