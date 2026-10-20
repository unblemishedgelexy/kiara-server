'use strict';

const { analyzeQuery } = require('./queryAnalyzer');

const RECENT_REFERENCE = /\b(just|recently|a few minutes ago|minutes ago|earlier today|just now|what did i (?:say|tell you)|what did i just tell you|what were we discussing|where did we leave off|continue our discussion)\b/i;
const EXPLICIT_DURABLE = /\b(remember|do you remember|my preference|prefer|favorite|favourite|currently|current|goal|project|who am i|my name|what kind of|what framework)\b/i;
const NATURAL_RECALL = /\b(?:what|which|who|where|when|how)\b.*\b(?:i (?:mentioned|said|told you)|did i (?:mention|say|tell you)|we discussed)\b/i;
const EXPLICIT_HISTORICAL = /\b(used to|before|previously|formerly|historical|history|earlier today|what did i say earlier)\b/i;
const DIRECT_FACT_LOOKUP = /\b(?:what(?:'s| is| are) my|which of my|tell me (?:my|what)|remind me (?:what|which|my)|who is my)\b/i;
const STRUCTURED_ONLY_QUERY = /\bremember\b.*\b(?:project|preference|favorite|favourite|codename|name|goal)\b/i;
const SEMANTIC_INTENTS = new Set(['PROJECT', 'GOAL', 'RELATIONSHIP', 'FACT', 'EPISODE', 'GENERAL_MEMORY']);

function routeMemorySources(query, options = {}) {
  const text = String(query || '').trim();
  const analysis = analyzeQuery(text);
  if (!text) {
    return {
      route: 'LONG_TERM_ONLY',
      sources: ['LONG_TERM'],
      reason: {
        recentContext: false,
        durableMemory: true,
        semanticRecall: false,
        defaultContext: true,
      },
      analysis,
    };
  }

  const currentState = /\b(current|currently|right now|what do i .* prefer)\b/i.test(text);
  const semanticOnly = Boolean(options.semanticOnly);
  const directFactLookup = DIRECT_FACT_LOOKUP.test(text) || STRUCTURED_ONLY_QUERY.test(text);
  const recent = !semanticOnly && Boolean(options.recent || analysis.needsRecentContext || RECENT_REFERENCE.test(text) || currentState);
  const durable = !semanticOnly && Boolean(
    options.historical
    || options.current
    || EXPLICIT_DURABLE.test(text)
    || NATURAL_RECALL.test(text)
    || EXPLICIT_HISTORICAL.test(text)
    || analysis.intent !== 'GENERAL_MEMORY'
  );
  const history = Boolean(options.historical || EXPLICIT_HISTORICAL.test(text));
  const semantic = Boolean(
    semanticOnly
    || (options.semantic !== false
      && durable
      && !directFactLookup
      && SEMANTIC_INTENTS.has(analysis.intent)
      && (analysis.intent !== 'IDENTITY' || history || /\bremember\b/i.test(text)))
  );
  const sources = [];
  if (recent) sources.push('STM');
  if (durable) sources.push('LONG_TERM');
  if (semantic) sources.push('SEMANTIC');

  let route = 'NONE';
  if (sources.length === 1) route = `${sources[0]}_ONLY`;
  else if (sources.length === 2) route = `${sources[0]}_AND_${sources[1]}`;
  else if (sources.length === 3) route = 'ALL';

  return {
    route,
    sources,
    reason: {
      recentContext: recent,
      currentState,
      durableMemory: durable,
      semanticRecall: semantic,
      semanticOnly,
      historical: history,
      intent: analysis.intent,
    },
    analysis,
  };
}

module.exports = {
  routeMemorySources,
};
