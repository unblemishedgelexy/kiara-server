'use strict';

const DISCOURSE_WORDS = new Set([
  'kya','kuch','haan','hmm','acha','achha','waise','bas','okay','ok','hello','hi','hehe','haha',
  'batao','dekho','sun','arre','are','bro','yaar','matlab','shayad','maybe','actually','like',
  'yes','no','hello','hey','sup','yo','namaste'
]);

const QUESTION_WORDS = new Set(['kya','ky','kaun','kis','kab','kahan','kyun','kaise','kon','kisne','mera','mere','hum','main','tum']);
const PRONOUNS = new Set(['main','mujhe','mere','mein','hum','ham','tum','aap','ap','wo','woh','ye','yeh','vo','koi','kuch']);
const GENERIC_NOUNS = new Set(['task','request','message','response','user','assistant']); // Removed project, memory, controller, route, api, session, conversation

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function trimmedTokenCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function looksLikeTechnicalNoise(text) {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (normalized.includes('/api/') || normalized.includes('http://') || normalized.includes('https://')) return true;
  if (/[{}()[\]<>]/.test(normalized)) return true;
  if (/(?:^|\s)(?:request|response|success|failed|error|status|gate|controller|working memory|session)(?:\s|$)/i.test(normalized)) return true;
  if (/^\w+\.(js|ts|tsx|json|md|txt|csv|py|java|css|html)$/i.test(normalized)) return true;
  if (/^\d+\s*(?:kb|mb|gb|ms|sec|mins?|hours?|days?)$/i.test(normalized)) return true;
  return false;
}

function isLikelyFragment(text) {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (normalized.length < 3) return true;
  if (normalized.split(/\s+/).length <= 2 && !/[a-z]/i.test(normalized)) return true;
  if (/^(?:kya|batao|waise|hmm|hello|hi|ok|okay|shuru|continue|chal|chalo|bas)$/i.test(normalized)) return true;
  return false;
}

function computeEvidence(text) {
  const normalized = normalizeText(text);
  const explicit = /\b(?:main|mujhe|mera|meri|hum|ham|aap|ap|naam|name|bhai|behen|friend|project|work|build|develop|pasand|pata|jaanta|skill|goal|aim|improve|learn|sikha|seekhna)\b/.test(normalized);
  const userAsserted = /\b(?:main|mujhe|mera|meri|hum|ham|aap|ap)\b/.test(normalized) || /\b(?:hai|hoon|hoga|kar raha|kar rahi|pasand|chahiye|chahata|sikha|seekhna)\b/.test(normalized);
  const repeated = /\b(?:repeated|again|har baar|bar bar)\b/.test(normalized);
  const contextual = /(\b(?:bhai|behen|friend|mother|father|sister|brother|project|company|team|college|school|colleague|teacher|partner|wife|husband|naam|skill|goal|redis|distributed|caching)\b)/.test(normalized);
  return { explicit, userAsserted, repeated, contextual };
}

function scoreCandidate(candidate) {
  let score = 0.3;  // Increased base from 0.25
  if (candidate.evidence.explicit) score += 0.35;
  if (candidate.evidence.userAsserted) score += 0.2;
  if (candidate.evidence.repeated) score += 0.1;
  if (candidate.evidence.contextual) score += 0.25;  // Increased for facts with contextual entities like "Redis"
  if (candidate.isGeneric) score -= 0.25;
  if (candidate.isConversational) score -= 0.35;
  if (candidate.isFragment) score -= 0.35;
  if (candidate.isTechnicalNoise) score -= 0.25;
  if (candidate.isTemporary) score -= 0.2;
  if (candidate.hasNoEntityEvidence && candidate.category !== 'fact') score -= 0.25;  // Facts can lack entity evidence
  if (candidate.hasNoUserSpecificEvidence && candidate.category !== 'fact') score -= 0.05;  // Minimal penalty for observational facts
  return Math.max(0, Math.min(1, score));
}

function classifyCandidate(text, contextText) {
  const normalized = normalizeText(text);
  const context = normalizeText(contextText || '');

  // More strict identity signals - require "naam"/"name" specifically
  const identitySignals = /(naam|name|call me|mera naam|meri naam|mera naam hai|meri naam hai)/i;
  
  // Relationship signals - more flexible to match patterns like "mera friend [name]" or "[name] mera [relation] hai"
  const relationshipSignals = /(?:mera|meri|mere|aapka|tumhara|tumhari|hamara|hamari)\s+(?:friend|bhai|behen|mother|father|uncle|aunt|sister|brother|teacher|colleague|partner|classmate|team\s+member)|(?:friend|bhai|behen|mother|father|uncle|aunt|sister|brother|teacher|colleague|partner|classmate|team\s+member).*\s+(?:hai|hain|ho|hoon)/i;
  
  // Project signals - match "par kaam", "kaam kar raha/rahi", "bana raha/rahi", "project", "app", "website", etc.
  const projectSignals = /(?:par\s+kaam|kaam\s*kar\s*raha|kaam\s*kar\s*rahi|bana\s*raha|bana\s*rahi|project|app|website|platform|healthcare|resume|builder)/i;
  
  // Goal patterns - check before preference/skill
  const goalSignals = /(?:goal|target|objective|plan|banana\s+hai|banna\s+hai|karna\s+hai|krna\s+hai|improve|perfect|perfecter)/i;
  
  // Skill patterns - check before preference (skill + learn > preference)
  // IMPORTANT: "develop" removed here to avoid matching "development" in generic tech facts
  const skillSignals = /(?:skill|sikhn|seekhna|learn|seekh|practise|practice|master|improve|coding|programming)/i;
  
  // Preference patterns (more specific - require actual preference verb forms)
  const preferenceSignals = /(?:pasand\s+(?:hai|nahi)|pasand|like|love|enjoy)/i;

  if (projectSignals.test(normalized) || projectSignals.test(context)) {
    return 'project';
  }

  // Check goal/skill BEFORE preference to avoid misclassification
  if (goalSignals.test(normalized) || goalSignals.test(context)) {
    return 'goal';
  }

  if (skillSignals.test(normalized) || skillSignals.test(context)) {
    return 'skill';
  }

  if (preferenceSignals.test(normalized) || preferenceSignals.test(context)) {
    return 'preference';
  }

  if (identitySignals.test(normalized) || identitySignals.test(context)) {
    return 'identity';
  }

  // Check relationship BEFORE falling back to fact
  if (relationshipSignals.test(normalized) || relationshipSignals.test(context)) {
    return 'relationship';
  }

  return 'fact';
}

const { log: traceLog } = require('./utils/memoryTrace');

function extractMemoryCandidates(rawText, context = {}) {
  const sourceText = String(rawText || '').trim();
  const memoryTraceId = context.memoryTraceId || null;
  const sourceRole = context.sourceRole || 'unknown';  // Track source: 'user' or 'assistant'
  if (!sourceText) {
    return [];
  }

  const text = sourceText.replace(/\s+/g, ' ').trim();
  traceLog('candidate_input', { memoryTraceId, source: sourceRole, candidates: [sourceText] });
  const tokens = text.split(/\s+/).filter(Boolean);

  const candidates = [];

  const segments = text
    .split(/[.!?]+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !/^(?:kya|batao|waise|hmm|hello|ok|okay|hi|hey|hehe|haha|bas|shuru|continue|chal|chalo)$/i.test(segment));

  for (const segment of segments) {
    const normalized = normalizeText(segment);
    if (!normalized) continue;

    const isConversational = DISCOURSE_WORDS.has(normalized) || tokenContainsAny(normalized, DISCOURSE_WORDS);
    const isFragment = isLikelyFragment(normalized) || trimmedTokenCount(normalized) <= 2 || /^(?:shuru|continue|kal|aaj|batao|dekho|sun)/i.test(normalized);
    const isTechnicalNoise = looksLikeTechnicalNoise(normalized);
    const hasEntityEvidence = /\b(?:[A-Z][a-z]+|[A-Z]{2,}|[a-z]*[A-Z][a-z]+|[A-Za-z]{3,})\b/.test(segment) || /\b(?:rahul|neha|kiara|nirmal|ravi|healthcare|resume|builder|ai|project|team|school|college|office)\b/i.test(normalized);
    const hasUserSpecificEvidence = /\b(?:main|mujhe|mera|meri|hum|ham|aap|ap|mein|my|i am|i'm)\b/.test(normalized);
    const isGeneric = PRONOUNS.has(normalized) || QUESTION_WORDS.has(normalized) || GENERIC_NOUNS.has(normalized) || /\b(?:task|request|message|response|session|conversation|controller|route|api)\b/i.test(normalized);
    const isTemporary = /\b(?:request failed|memory gate closed|working memory controller|success false|error|failed|api|route)\b/i.test(normalized);

    if (isConversational || isFragment || isTechnicalNoise || isTemporary || (!hasEntityEvidence && !hasUserSpecificEvidence)) {
      continue;
    }

    const evidence = computeEvidence(normalized);
    const category = classifyCandidate(segment, text);
    const candidate = {
      candidateId: `cand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category,
      value: segment,
      sourceText: sourceText,
      sourceTurnId: undefined,
      source: sourceRole,  // Track whether from user or assistant
      evidence,
      preliminaryConfidence: scoreCandidate({
        evidence,
        isGeneric,
        isConversational,
        isFragment,
        isTechnicalNoise,
        isTemporary,
        hasNoEntityEvidence: !hasEntityEvidence,
        hasNoUserSpecificEvidence: !hasUserSpecificEvidence,
      }),
      isGeneric,
      isConversational,
      isFragment,
      isTechnicalNoise,
      isTemporary,
      hasNoEntityEvidence: !hasEntityEvidence,
      hasNoUserSpecificEvidence: !hasUserSpecificEvidence,
    };

    traceLog('semantic_classification', {
      memoryTraceId,
      source: sourceRole,
      candidate: candidate.value,
      category: candidate.category,
      confidence: Number(candidate.preliminaryConfidence || 0).toFixed(3),
      evidence: candidate.evidence,
      sourceTurnId: context.sourceTurnId || null,
    });

    const valid = candidate.preliminaryConfidence >= 0.4;
    traceLog('candidate_validation', {
      memoryTraceId,
      source: sourceRole,
      candidate: candidate.value,
      category: candidate.category,
      validator: `${candidate.category}_validator`,
      valid,
      confidence: Number(candidate.preliminaryConfidence || 0).toFixed(3),
      evidence: candidate.evidence,
      rejectionReason: valid ? null : 'low_confidence_or_discourse_fragment',
    });

    if (candidate.preliminaryConfidence >= 0.4) {
      candidates.push(candidate);
    }
  }

  const deduped = dedupeCandidates(candidates);
  const rejectedCandidates = Array.from(new Set((candidates || []).map((c) => c.value))).filter((value) => !deduped.some((item) => item.value === value));
  traceLog('garbage_filter_result', {
    memoryTraceId,
    source: sourceRole,
    inputCandidates: [sourceText],
    rejectedCandidates,
    rejectedReasons: ['low_confidence_or_discourse_fragment'],
    survivingCandidates: deduped.map((candidate) => ({ candidate: candidate.value, category: candidate.category, source: candidate.source, decision: 'KEEP', reason: 'explicit_identity_evidence' }))
  });
  return deduped;
}

function tokenContainsAny(text, set) {
  return text.split(/\s+/).some((token) => set.has(token));
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = `${candidate.category}:${candidate.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function extractIdentityName(text) {
  const value = normalizeText(text || '');
  if (!value) return null;

  const questionPattern = /\b(?:kya|kaun|kis|kyun|kab|kahan|kon)\b/i;
  if (questionPattern.test(value) && !/\b(?:naam|name)\s+(?:is|hai|hain|hoon|hun)\b/i.test(value)) {
    return null;
  }

  const identityPatterns = [
    /(?:my\s+name\s+is|i\s+am|i'm|this\s+is|(?:mera|meri|mere|aapka|tumhara|tumhari|hamara|hamari)\s+naam|main\s+hoon|main\s+hun)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{1,40}?)(?=\s+(?:hai|hain|hoon|hun|\.|,|$))/i,
    /(?:naam)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{1,40}?)(?=\s+(?:hai|hain|hoon|hun|\.|,|$))/i,
    /(?:name\s+is|naam\s+hai|naam\s+hain)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{1,40}?)(?=\s+(?:hai|hain|hoon|hun|\.|,|$))/i,
  ];

  for (const pattern of identityPatterns) {
    const match = value.match(pattern);
    if (match && match[1]) {
      const extracted = normalizeText(match[1].replace(/^(?:i\s+am|i'm|main|this is|mera naam|meri naam|aapka naam|tumhara naam|hamara naam)\s+/i, ''));
      if (extracted && !/\b(?:kya|kaun|kis|kyun|kab|kahan|kon)\b/i.test(extracted)) {
        return extracted;
      }
    }
  }

  return null;
}

function extractCanonicalValue(rawText, category) {
  const text = normalizeText(rawText || '');
  if (!text) return null;

  if (category === 'identity' || /(?:naam|name)/i.test(text)) {
    const directIdentityName = extractIdentityName(text);
    if (directIdentityName) {
      return directIdentityName;
    }
  }

  if (category === 'preference' || category === 'project' || category === 'goal' || category === 'relationship' || category === 'skill' || category === 'fact') {
    return text;
  }

  return text;
}

function extractCanonicalSemanticMemories(rawText, context = {}) {
  const candidates = extractMemoryCandidates(rawText, context);
  const grouped = {};

  for (const candidate of candidates) {
    let category = String(candidate.category || 'fact');
    const candidateText = normalizeText(candidate.value || '');
    const explicitNameMatch = /(?:mera|meri|mere|aapka|tumhara|tumhari|hamara|hamari)\s+naam\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{1,40}?)(?=\s+(?:hai|hain|hoon|hun|\.|,|$))/i.exec(candidateText);
    if (explicitNameMatch) {
      category = 'identity';
    }

    if (!['identity', 'relationship', 'preference', 'goal', 'project', 'skill', 'fact'].includes(category)) {
      continue;
    }

    const canonicalValue = extractCanonicalValue(candidateText, category);
    if (!canonicalValue || !String(canonicalValue).trim()) {
      continue;
    }

    const key = category === 'identity' ? 'name' : category;
    const fact = {
      id: `semantic:${category}:${String(key).toLowerCase()}:${String(canonicalValue).toLowerCase().replace(/[^a-z0-9\u0900-\u097F]+/g, '_').slice(0, 64)}`,
      category,
      key,
      label: category === 'identity' ? 'Name' : category,
      value: canonicalValue,
      source: candidate.source || 'unknown',  // Track source: user or assistant
      confidenceScore: category === 'identity' && candidate.source === 'user' ? 0.95 : Number(candidate.preliminaryConfidence || 0.75),  // HIGH confidence for user-stated identity
      importance: (category === 'identity' && candidate.source === 'user' ? 0.95 : Number(candidate.preliminaryConfidence || 0.75)) * 0.9 + 0.1,
      reason: category === 'identity' ? `Explicit user identity fact directly stated in transcript (source: ${candidate.source}).` : 'Explicit statement preserved in semantic memory.',
      source_turn_ids: context.sourceTurnId ? [context.sourceTurnId] : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    grouped[category] = grouped[category] || [];
    grouped[category].push(fact);
  }

  return grouped;
}

module.exports = {
  extractMemoryCandidates,
  extractCanonicalSemanticMemories,
  DISCOURSE_WORDS,
  QUESTION_WORDS,
  PRONOUNS,
  GENERIC_NOUNS,
  normalizeText,
  computeEvidence,
  classifyCandidate,
  scoreCandidate,
};
