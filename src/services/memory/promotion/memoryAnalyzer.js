'use strict';

const { createHash } = require('crypto');
const logger = require('../utils/memoryLogger');

const FACT_PATTERNS = [
  {
    category: 'identity',
    key: 'name',
    label: 'Name',
    regex: /(?:my name is|i am|i'm|this is)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/i,
  },
  {
    category: 'relationships',
    key: 'relationship',
    label: 'Relationship',
    regex: /\b(?:my (?:wife|husband|partner|boyfriend|girlfriend|friend|sister|brother|mother|father|dad|mom|colleague|boss)|(I am|I'm) (?:married to|dating|seeing))\s+([^.!?\n]+)/i,
  },
  {
    category: 'occupation',
    key: 'occupation',
    label: 'Occupation',
    regex: /\b(?:I work as|I am a|I'm a|I am an|I'm an|I serve as|I am the)\s+([^.!?\n]+)/i,
  },
  {
    category: 'location',
    key: 'location',
    label: 'Location',
    regex: /\b(?:I live in|I'm from|I am from|based in)\s+([^.!?\n]+)/i,
  },
  {
    category: 'preferences',
    key: 'likes',
    label: 'Likes',
    regex: /\b(?:I like|I love|I enjoy|My favorite(?: thing)? is|I prefer)\s+([^.!?\n]+)/i,
  },
  {
    category: 'preferences',
    key: 'dislikes',
    label: 'Dislikes',
    regex: /\b(?:I dislike|I hate|I don't like|I do not like)\s+([^.!?\n]+)/i,
  },
  {
    category: 'goals',
    key: 'goal',
    label: 'Goal',
    regex: /\b(?:my goal is|I want to|I'm trying to|I am trying to|I plan to|I would like to|I need to)\s+([^.!?\n]+)/i,
  },
  {
    category: 'projects',
    key: 'project',
    label: 'Project',
    regex: /\b(?:project|initiative|working on)\s+([^.!?\n]+)/i,
  },
  {
    category: 'skills',
    key: 'skill',
    label: 'Skill',
    regex: /\b(?:I can|I know|I learned|I'm learning|I am learning)\s+([^.!?\n]+)/i,
  },
  {
    category: 'family',
    key: 'family',
    label: 'Family',
    regex: /\b(?:my (?:mother|father|mom|dad|sister|brother|wife|husband|son|daughter|family))\s+(?:is|are|called|named)?\s*([^.!?\n]+)/i,
  },
  {
    category: 'friends',
    key: 'friend',
    label: 'Friend',
    regex: /\b(?:my friend|my best friend|friend named|friend called)\s+([^.!?\n]+)/i,
  },
];

const TOPIC_PATTERNS = [
  /\b(frontend|backend|mobile|web|ai|gemini|voice|face|identity|memory|redis|pinecone|deployment|debugging|profile|auth|login|logout|session)\b/gi,
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripAnimationJson(value) {
  let text = String(value || '').trim();
  if (!text) return '';

  const animationKeys = new Set([
    'emotion',
    'intensity',
    'animation',
    'eyeState',
    'gesture',
    'headTilt',
    'mouthState',
    'camera',
    'microphone',
    'expression',
  ]);

  let changed = true;
  while (changed) {
    changed = false;
    text = text.replace(/\{[\s\S]*?\}/g, (candidate) => {
      try {
        const parsed = JSON.parse(candidate);
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          Object.keys(parsed).some((key) => animationKeys.has(key))
        ) {
          changed = true;
          return ' ';
        }
      } catch {
        // leave non-JSON braces alone
      }
      return candidate;
    });
  }

  return normalizeText(text
    .replace(/\b(?:emotion|camera|gesture|animation|microphone|headTilt|eyeState|mouthState)\s*:\s*[^,\n]+/gi, ' ')
    .replace(/\b(?:system prompt|metadata)\b\s*:?\s*/gi, ' '));
}

function normalizeHumanText(value) {
  return stripAnimationJson(value)
    .replace(/^(?:User|U|Assistant|A|Kiara|K)\s*:\s*/i, '')
    .trim();
}

function splitSentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function extractFactsFromSentence(sentence) {
  const facts = [];

  for (const pattern of FACT_PATTERNS) {
    const match = sentence.match(pattern.regex);
    if (!match) continue;

    const value = normalizeText(match[1] || match[2] || '');
    if (!value) continue;

    facts.push({
      category: pattern.category,
      key: pattern.key,
      label: pattern.label,
      value,
      sourceText: sentence,
    });
  }

  return facts;
}

function extractTopics(text) {
  const found = new Set();
  const normalized = normalizeText(text);

  for (const pattern of TOPIC_PATTERNS) {
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const topic = (match[1] || match[0]).toLowerCase();
      found.add(topic);
    }
  }

  return Array.from(found).slice(0, 8);
}

function extractEntities(text) {
  const entities = new Set();
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    const caps = sentence.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
    for (const entity of caps) {
      if (entity.length > 2 && !/^I$/.test(entity)) {
        entities.add(entity);
      }
    }
  }

  return Array.from(entities).slice(0, 12);
}

function extractDecisions(text) {
  const sentences = splitSentences(text);
  return sentences.filter((sentence) => /\b(?:decide|decided|plan to|will|should|need to|must|schedule|book|try to|need to)\b/i).slice(0, 5);
}

function buildEpisode(turns, analysis) {
  const startTime = turns.length ? turns[0].timestamp : new Date().toISOString();
  const endTime = turns.length ? turns[turns.length - 1].timestamp : startTime;
  const timeline = turns
    .map((turn) => {
      const user = normalizeHumanText(turn.userMessage || '');
      const assistant = normalizeHumanText(turn.assistantResponse || turn.aiResponse || turn.assistantMessage || '');
      if (!user || !assistant) {
        return null;
      }
      return {
        timestamp: turn.timestamp,
        user,
        assistant,
      };
    })
    .filter(Boolean);

  const compressedConversation = timeline
    .map((turn) => `T:${turn.timestamp}\nU:${turn.user}\nK:${turn.assistant}`)
    .join('\n\n');

  const titleParts = [];
  if (analysis.topics.length) {
    titleParts.push(analysis.topics.slice(0, 3).join(', '));
  }
  if (analysis.facts.length) {
    const factSummary = analysis.facts[0].value;
    if (factSummary) {
      titleParts.push(factSummary.split(' ').slice(0, 5).join(' '));
    }
  }

  const title = titleParts.length
    ? `Conversation about ${titleParts.join(' / ')}`
    : 'Conversation with Kiara';

  const summary = analysis.topics.length
    ? `Conversation covering ${analysis.topics.join(', ')}.`
    : 'Conversational episode captured for future recall.';

  const outcome = analysis.decisions.length
    ? analysis.decisions.join(' | ')
    : normalizeHumanText(turns[turns.length - 1]?.userMessage || turns[turns.length - 1]?.assistantMessage || 'No explicit conclusion.');

  const emotion = inferConversationEmotion(compressedConversation);
  const embeddingText = [
    summary,
    analysis.topics.length ? `Topics: ${analysis.topics.join(', ')}` : '',
    analysis.entities.length ? `Entities: ${analysis.entities.join(', ')}` : '',
    compressedConversation,
  ].filter(Boolean).join('\n\n');

  return {
    memoryType: 'episode',
    title,
    summary,
    participants: ['user', 'Kiara'],
    topics: analysis.topics,
    entities: analysis.entities,
    decisions: analysis.decisions,
    emotion,
    timeline,
    outcome: normalizeText(outcome),
    text: compressedConversation,
    embeddingText,
    startTime,
    endTime,
    createdAt: startTime,
    updatedAt: endTime,
  };
}

function inferConversationEmotion(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(?:sad|hurt|upset|cry|lonely|anxious|worried|scared)\b/.test(lower)) return 'sensitive';
  if (/\b(?:happy|excited|great|awesome|love|fun)\b/.test(lower)) return 'positive';
  if (/\b(?:angry|annoyed|frustrated|hate|irritated)\b/.test(lower)) return 'tense';
  return 'neutral';
}

function hashId(seed) {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function normalizeFactKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

function uniqueFacts(facts) {
  const seen = new Map();
  const result = [];

  for (const fact of facts) {
    const key = `${fact.category}:${fact.key}:${fact.value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, true);
    result.push(fact);
  }

  return result;
}

function createFactId(userId, fact) {
  return `fact:${userId}:${normalizeFactKey(fact.key)}:${hashId(fact.value)}`;
}

function groupSemanticMemories(facts) {
  // Normalize plural category names to singular to match extraction.js
  const categoryNormalizer = {
    'skills': 'skill',
    'goals': 'goal',
    'preferences': 'preference',
    'projects': 'project',
    'relationships': 'relationship',
    'long_term_facts': 'fact',
    'facts': 'fact',
  };

  const buckets = {
    identity: [],
    relationship: [],
    preference: [],
    goal: [],
    project: [],
    skill: [],
    fact: [],
  };

  for (const fact of facts) {
    // Normalize category name if needed
    let normalizedCategory = String(fact.category || 'fact').toLowerCase();
    if (categoryNormalizer[normalizedCategory]) {
      normalizedCategory = categoryNormalizer[normalizedCategory];
    }
    
    // Also normalize the fact object's category field itself
    fact.category = normalizedCategory;
    
    const target = buckets[normalizedCategory] ? normalizedCategory : 'fact';
    buckets[target].push(fact);
  }

  return buckets;
}

function buildFallbackFacts(transcript, userId) {
  const sentences = splitSentences(transcript);
  const fallbackFacts = [];
  const seen = new Set();

  for (const sentence of sentences) {
    const extracted = extractFactsFromSentence(sentence);
    for (const fact of extracted) {
      const category = fact.category || 'facts';
      const id = createFactId(userId, fact);
      const key = fact.key || category;
      const value = fact.value || fact.content || '';
      const label = fact.label || key;
      const sourceTurnIds = [];
      const match = sentence.match(/TURN_ID:([^\n\r]+)/);
      if (match) {
        sourceTurnIds.push(match[1]);
      }

      const fingerprint = `${category}:${key}:${value}`.toLowerCase();
      if (seen.has(fingerprint) || !value) continue;
      seen.add(fingerprint);

      fallbackFacts.push({
        id,
        category,
        key,
        label,
        value,
        confidenceScore: 0.72,
        importance: 0.55,
        reason: `Extracted from transcript using fallback regex: ${sentence}`.slice(0, 300),
        source_turn_ids: sourceTurnIds,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return fallbackFacts;
}

async function analyzeConversation(turns, userId = 'unknown') {
  // Build transcript and map turn ids
  const transcriptEntries = [];
  const turnIdMap = {};
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i] || {};
    const uid = t.id || `turn_${i}`;
    turnIdMap[i] = uid;
    const user = normalizeHumanText(t.userMessage || '');
    const assistant = normalizeHumanText(t.assistantResponse || t.aiResponse || t.assistantMessage || '');
    transcriptEntries.push({ id: uid, user, assistant, timestamp: t.timestamp || null });
  }

  const transcript = transcriptEntries.map((e) => `TURN_ID:${e.id}\nUSER:${e.user}\nASSISTANT:${e.assistant}`).join('\n\n');

  logger.memoryAnalyzer({ userId, rule: 'ai_extraction', status: 'conversation_received', turnCount: turns.length, transcriptLength: String(transcript).length });

  // If Gemini API key is missing, return empty set (do not fabricate)
  const { GEMINI_TEXT_MODEL } = require('../../../config/constants');
  const { env } = require('../../../config/env');
  if (!env.geminiApiKey && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    logger.memoryAnalyzer({ userId, rule: 'ai_extraction', status: 'gemini_unavailable', reason: 'no_api_key' });
    return {
      facts: [],
      semanticMemories: groupSemanticMemories([]),
      topics: [],
      entities: [],
      decisions: [],
    };
  }

  // Build a strict instruction prompt for structured JSON output
  const prompt = `You are a Memory Extraction Engine. Given a conversation transcript, extract ONLY information worth remembering.\n\n` +
    `Return a single JSON object with these keys:\n` +
    `- memories: an array of memory objects (zero or more).\n` +
    `- rejected: an array of rejected candidate summaries with reason for rejection.\n` +
    `- summary: short summary of the conversation.\n\n` +
    `Each memory object MUST have these fields:\n` +
    `- id: short unique id (you may synthesize but only if supported by text)\n` +
    `- type: short type string (e.g. 'fact','identity','project','goal','task','preference','event')\n` +
    `- category: one of [identity,relationships,preferences,projects,goals,long_term_facts,skills,locations,organizations,important_events,important_episodes,temporary_tasks,conversation_summary]\n` +
    `- content: the textual content or value exactly supported by the transcript\n` +
    `- confidence: number between 0 and 1 (how sure you are)\n` +
    `- importance: number between 0 and 1 (how important to keep long-term)\n` +
    `- reason: one-line justification why this should be remembered (cite supporting excerpt)\n` +
    `- source_turn_ids: array of TURN_ID values from the transcript that support this memory\n` +
    `- createdAt: ISO timestamp or null\n` +
    `- updatedAt: ISO timestamp or null\n` +
    `- memoryTTL: seconds this should be kept (or null)
    - promotionPriority: 0-1\n\n` +
    `Important rules:\n` +
    `- DO NOT INVENT facts. Only return memories that are directly supported by the transcript.\n` +
    `- If nothing permanent exists, return {"memories": []}.\n` +
    `- The response MUST be valid JSON and ONLY JSON (no explanatory text).\n\n` +
    `Transcript:\n${transcript}\n\n`;

  // Call Gemini
  try {
    const { GoogleGenAI } = require('@google/genai');
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || env.geminiApiKey;
    const client = new GoogleGenAI({ apiKey });
    const model = GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: { candidateCount: 1, temperature: 0.0, maxOutputTokens: 3000 },
    });

    const raw = (response && (response.text || response.outputText || response.output?.[0]?.content || response.data?.[0]?.content)) || response?.text || '';
    logger.memoryAnalyzer({ userId, rule: 'ai_extraction', status: 'raw_response', length: String(raw || '').length, rawPreview: String(raw || '').slice(0, 800) });

    function stripCodeFences(text) {
      let value = String(text || '').trim();
      if (!value) return '';
      value = value.replace(/^```(?:json)?\s*/i, '');
      value = value.replace(/\s*```\s*$/i, '');
      value = value.replace(/^`+/, '').replace(/`+$/, '');
      return value.trim();
    }

    function extractJsonObject(text) {
      const cleaned = stripCodeFences(text);
      const starts = [];
      for (let i = 0; i < cleaned.length; i += 1) {
        if (cleaned[i] === '{') {
          starts.push(i);
        }
      }

      for (const start of starts) {
        let depth = 0;
        let inString = false;
        let escapeNext = false;
        for (let i = start; i < cleaned.length; i += 1) {
          const ch = cleaned[i];
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          if (ch === '\\') {
            escapeNext = true;
            continue;
          }
          if (ch === '"') {
            inString = !inString;
            continue;
          }
          if (inString) {
            continue;
          }
          if (ch === '{') {
            depth += 1;
          } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              return cleaned.slice(start, i + 1).trim();
            }
          }
        }
      }
      return null;
    }

    function tryParseJson(rawText) {
      const candidate = stripCodeFences(rawText);
      try {
        return JSON.parse(candidate);
      } catch {
        const extracted = extractJsonObject(rawText);
        if (extracted) {
          try {
            return JSON.parse(extracted);
          } catch {
            // fall through
          }
        }
      }
      return null;
    }

    let parsed = tryParseJson(raw);

    if (!parsed || !Array.isArray(parsed.memories)) {
      const cleanedCandidate = stripCodeFences(raw).slice(0, 1400);
      const extractedCandidate = extractJsonObject(raw) || '';
      logger.memoryAnalyzer({ userId, rule: 'ai_extraction', status: 'parse_failed', reason: 'invalid_json', rawPreview: String(raw || '').slice(0, 1200), cleanedCandidate, extractedCandidate: String(extractedCandidate).slice(0, 1200) });

      const fallbackFacts = buildFallbackFacts(transcript, userId);
      if (fallbackFacts.length) {
        const groupedFallback = groupSemanticMemories(fallbackFacts);
        const categoryCounts = {};
        fallbackFacts.forEach((a) => { categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1; });
        logger.memoryAnalyzer({ userId, rule: 'ai_extraction', status: 'fallback_extracted', extractedCount: fallbackFacts.length, categoryCounts, confidenceDistribution: fallbackFacts.map((a) => Number(a.confidenceScore || 0)).slice(0, 50) });
        return {
          facts: fallbackFacts,
          semanticMemories: groupedFallback,
          topics: extractTopics(transcript),
          entities: extractEntities(transcript),
          decisions: extractDecisions(transcript),
        };
      }

      return {
        facts: [],
        semanticMemories: groupSemanticMemories([]),
        topics: extractTopics(transcript),
        entities: extractEntities(transcript),
        decisions: extractDecisions(transcript),
      };
    }

    const accepted = [];
    const rejected = [];
    for (const m of parsed.memories) {
      // validate required fields
      if (!m || !m.category || !m.content || !Array.isArray(m.source_turn_ids)) {
        rejected.push({ item: m, reason: 'missing_required_fields' });
        continue;
      }
      // Only accept known categories
      const cat = String(m.category).toLowerCase();
      const allowed = new Set(['identity','relationships','preferences','projects','goals','long_term_facts','skills','locations','organizations','important_events','important_episodes','temporary_tasks','conversation_summary']);
      if (!allowed.has(cat)) {
        rejected.push({ item: m, reason: 'unknown_category' });
        continue;
      }
      // Ensure source_turn_ids reference existing turn ids
      const validTurnIds = (m.source_turn_ids || []).filter((id) => transcript.includes(String(id)));
      if (!validTurnIds.length) {
        rejected.push({ item: m, reason: 'no_supporting_turn_ids' });
        continue;
      }

      const mem = Object.assign({}, m);
      mem.category = cat;
      mem.id = mem.id || (`mem:${userId}:${hashId(mem.content || mem.category)}`);
      mem.confidence = Number(mem.confidence || 0) || 0;
      mem.importance = Number(mem.importance || 0) || 0;
      mem.reason = String(mem.reason || '').slice(0, 400);
      mem.source_turn_ids = validTurnIds;
      mem.createdAt = mem.createdAt || new Date().toISOString();
      mem.updatedAt = mem.updatedAt || mem.createdAt;
      mem.memoryTTL = mem.memoryTTL || null;
      mem.promotionPriority = Number(mem.promotionPriority || 0) || 0;
      accepted.push(mem);
    }

    // Logging
    const categoryCounts = {};
    accepted.forEach((a) => { categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1; });
    const confidenceDist = accepted.map((a) => Number(a.confidence || 0));
    logger.memoryAnalyzer({ userId, rule: 'ai_extraction', status: 'extracted', extractedCount: accepted.length, rejectedCount: rejected.length, categoryCounts, confidenceDistribution: confidenceDist.slice(0, 50) });

    // Map memories to facts compatible shape with normalized categories
    const categoryNormalizer = {
      'skills': 'skill',
      'goals': 'goal',
      'preferences': 'preference',
      'projects': 'project',
      'relationships': 'relationship',
      'long_term_facts': 'fact',
      'facts': 'fact',
    };

    const facts = accepted.map((a) => {
      let normalizedCategory = String(a.category || 'fact').toLowerCase();
      if (categoryNormalizer[normalizedCategory]) {
        normalizedCategory = categoryNormalizer[normalizedCategory];
      }
      return {
        id: a.id,
        category: normalizedCategory,
        key: a.type || normalizedCategory,
        label: a.type || normalizedCategory,
        value: a.content,
        confidenceScore: Number(a.confidence || 0),
        importance: Number(a.importance || 0),
        reason: a.reason || '',
        source_turn_ids: a.source_turn_ids || [],
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
    });

    const grouped = groupSemanticMemories(facts);

    // Final promotion payload log
    logger.memoryAnalyzer({ userId, rule: 'ai_extraction', status: 'final_payload', finalCounts: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])), sample: facts.slice(0, 6) });

    return {
      facts,
      semanticMemories: grouped,
      topics: parsed.summary ? extractTopics(parsed.summary) : extractTopics(transcript),
      entities: extractEntities(transcript),
      decisions: parsed.summary ? extractDecisions(parsed.summary) : extractDecisions(transcript),
    };
  } catch (err) {
    logger.memoryAnalyzer({ userId, rule: 'ai_extraction', status: 'error', error: err && err.message ? err.message : String(err) });
    return {
      facts: [],
      semanticMemories: groupSemanticMemories([]),
      topics: extractTopics(transcript),
      entities: extractEntities(transcript),
      decisions: extractDecisions(transcript),
    };
  }
}

module.exports = {
  analyzeConversation,
  buildEpisode,
};
