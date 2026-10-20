'use strict';

const { summarizeMemory } = require('./memoryContextBuilder');

function formatCandidate(candidate) {
  if ((candidate.retrievalSource || candidate.source) === 'stm') {
    const message = String(candidate.userMessage || candidate.content || '').trim();
    return message ? `Recent conversation: User recently said ${message}` : '';
  }

  const summary = summarizeMemory(candidate);
  if (!summary) return '';
  const conflictLabel = candidate.conflict ? ' (recent statement conflicts; current evidence shown separately)' : '';
  const historicalLabel = candidate.historicalCandidate ? ' (previously recorded)' : '';
  return `Relevant memory: ${summary}${historicalLabel}${conflictLabel}`;
}

function buildUnifiedContext(memories = [], maxLength = 1800) {
  const recent = memories.filter((memory) => (memory.retrievalSource || memory.source) === 'stm');
  const durable = memories.filter((memory) => (memory.retrievalSource || memory.source) !== 'stm');
  const lines = [];

  for (const candidate of recent.slice(-3)) {
    const line = formatCandidate(candidate);
    if (line) lines.push(line);
  }
  for (const candidate of durable.slice(0, 6)) {
    const line = formatCandidate(candidate);
    if (line) lines.push(line);
  }

  const text = lines.join('\n');
  const limit = Math.min(Math.max(Number(maxLength) || 1800, 100), 8000);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

module.exports = {
  buildUnifiedContext,
};
