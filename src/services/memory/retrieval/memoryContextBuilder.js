'use strict';

const { rankMemories } = require('./relevanceRanker');

function summarizeMemory(memory) {
  const subject = memory.subject ? String(memory.subject).trim() : '';
  const predicate = memory.predicate ? String(memory.predicate).trim() : '';
  const value = memory.value ? String(memory.value).trim() : '';
  const content = memory.content ? String(memory.content).trim() : '';
  const fact = content && content !== value
    ? [value, content].filter(Boolean).join(': ')
    : value || content;

  if (subject || predicate || fact) {
    return [subject, predicate, fact].filter(Boolean).join(' -> ');
  }

  return content;
}

function buildContext({ memories = [], query = '', analysis = null, maxLength = 1400 } = {}) {
  const ranked = rankMemories(memories, analysis || { rawQuery: query, intent: 'GENERAL_MEMORY', keywords: [], entities: [] });
  const selected = ranked.slice(0, 8);

  const lines = selected.map((memory) => {
    const status = memory.status ? ` [${memory.status}]` : '';
    const summary = summarizeMemory(memory);
    return `- ${summary}${status} (score=${Number(memory.score || 0).toFixed(2)})`;
  });

  const compact = lines.join('\n');
  const safeText = compact.length > maxLength ? `${compact.slice(0, maxLength - 40)}...` : compact;

  return {
    summary: safeText || 'No relevant memory found.',
    memories: selected,
  };
}

module.exports = {
  buildContext,
  summarizeMemory,
};
