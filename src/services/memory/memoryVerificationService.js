const crypto = require('crypto');
const memoryPipelineService = require('./memoryPipelineService');
const memoryExtractor = require('./memoryExtractorService');
const { decrypt } = require('../../utils/crypto');
const RelationshipMemory = require('../../models/RelationshipMemory');
const LongTermMemory = require('../../models/LongTermMemory');
const personProfileService = require('./personProfileService');
const memoryNameIndexService = require('./memoryNameIndexService');
const sessionBootstrapService = require('./sessionBootstrapService');
const continuityRestorationEngine = require('./continuityRestorationEngine');
const systemPromptBuilderService = require('./systemPromptBuilderService');
const memoryProfileService = require('./memoryProfileService');
const memoryRetrievalService = require('./memoryRetrievalService');
const relationshipCacheService = require('../infrastructure/relationshipCacheService');
const bootstrapCacheService = require('./bootstrapCacheService');
const bootstrapVerificationService = require('./bootstrapVerificationService');
const geminiService = require('../live/geminiService');

function createFingerprint(text) {
  return crypto.createHash('sha256').update(String(text || '').trim().toLowerCase()).digest('hex');
}

function extractPersonNameFromText(text) {
  const t = String(text || '');

  // Prefer explicit identity patterns first: "my name is X", "I am X"
  const identityMatch = t.match(/\b(?:my name is|i am|i'm)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i);
  if (identityMatch && identityMatch[1]) {
    return identityMatch[1].trim();
  }

  // Fall back to relationship parser but guard against short/common-word results
  const parsed = relationshipCacheService.parseRelationshipMemory(t);
  if (parsed && parsed.personName && String(parsed.personName).length > 2 && !/^my$/i.test(parsed.personName)) {
    return parsed.personName;
  }

  const fallback = t.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)/g) || [];
  const filtered = fallback.filter((candidate) => !['My', 'I', 'The', 'Best', 'Friend', 'Relationship', 'Is', 'With', 'And', 'Partner', 'Teammate'].includes(candidate));
  return filtered.length ? filtered[0] : 'Aman';
}

async function verifyMemoryLifecycle(userId, memoryText) {
  if (!userId || !memoryText) return { ok: false, reason: 'missing args' };

  await memoryPipelineService.processUserMessage({ userId, text: memoryText, role: 'user' }).catch(() => null);

  const extracted = memoryExtractor.extractAll(memoryText) || [];
  const fingerprints = Array.from(new Set(extracted.map((item) => createFingerprint(item.memory))));

  const foundRelationship = await RelationshipMemory.findOne({ userId, fingerprint: { $in: fingerprints } }).lean().catch(() => null);
  const foundLtm = await LongTermMemory.findOne({ userId, fingerprint: { $in: fingerprints } }).lean().catch(() => null);

  return {
    ok: Boolean(foundRelationship || foundLtm),
    relationshipSaved: Boolean(foundRelationship),
    ltmSaved: Boolean(foundLtm),
    relationshipId: foundRelationship?._id || null,
    ltmId: foundLtm?._id || null,
  };
}

async function verifyRelationshipRecall(userId, personName) {
  if (!userId || !personName) return { ok: false, reason: 'missing args' };
  const profile = await personProfileService.getPersonProfile(userId, personName).catch(() => null);
  const indices = await memoryNameIndexService.searchByName(userId, personName).catch(() => []);
  const profilePresent = Boolean(profile);
  const indexPresent = (indices || []).length > 0;
  const profileSummary = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
  const relationshipInSummary = profileSummary && String(profileSummary.relationshipSummary || '').toLowerCase().includes(personName.toLowerCase());

  return {
    ok: profilePresent || indexPresent || relationshipInSummary,
    profilePresent,
    indexPresent,
    relationshipInSummary,
  };
}

async function verifyBootstrapCache(userId, personName) {
  if (!userId) return { ok: false, reason: 'missing args' };
  const bootstrap = await sessionBootstrapService.buildSessionBootstrapContext(userId, true).catch(() => null);
  const cached = await bootstrapCacheService.getBootstrapContext(userId).catch(() => null);
  const versionValid = await bootstrapVerificationService.verifyBootstrapVersion(userId).catch(() => false);
  const lowerName = String(personName || '').toLowerCase();
  const bootstrapContainsName = Boolean(bootstrap && JSON.stringify(bootstrap).toLowerCase().includes(lowerName));
  const profileContainsName = Boolean(
    bootstrap && bootstrap.profile && (
      String(bootstrap.profile.relationshipSummary || '').toLowerCase().includes(lowerName) ||
      String(bootstrap.profile.identitySummary || '').toLowerCase().includes(lowerName) ||
      String(bootstrap.profile.preferenceSummary || '').toLowerCase().includes(lowerName) ||
      String(bootstrap.profile.goalSummary || '').toLowerCase().includes(lowerName) ||
      String(bootstrap.profile.projectSummary || '').toLowerCase().includes(lowerName)
    )
  );

  return {
    ok: Boolean(bootstrap && bootstrap.bootstrapContext),
    bootstrapLoaded: Boolean(bootstrap && bootstrap.bootstrapContext),
    cached: Boolean(cached),
    versionValid,
    bootstrapContainsName,
    profileContainsName,
    bootstrap,
  };
}

async function verifySystemPrompt(userId, personName) {
  if (!userId) return { ok: false, reason: 'missing args' };
  const prompt = await systemPromptBuilderService.buildSystemPrompt(userId).catch(() => ({ systemPrompt: '' }));
  const containsName = Boolean(String(prompt.systemPrompt || '').toLowerCase().includes(String(personName || '').toLowerCase()));
  return { ok: containsName, containsName, prompt };
}

async function verifyGeminiPrompt(userId, personName, promptText) {
  if (!userId || !personName || !promptText) {
    return { ok: false, reason: 'missing args' };
  }

  if (!geminiService.hasGeminiServerAccess()) {
    return { ok: false, reason: 'gemini_unavailable' };
  }

  try {
    const validationPrompt = `System prompt:\n${promptText}\n\nQuestion: Based on the system prompt above, should Kiara recall and mention \"${personName}\"? Reply only with YES or NO and include the evidence.`;
    const response = await geminiService.generateText({ prompt: validationPrompt, maxOutputTokens: 128, temperature: 0, candidateCount: 1 });
    const responseText = String(response.text || '').trim();
    const lowerText = responseText.toLowerCase();
    const containsName = lowerText.includes(String(personName || '').toLowerCase());
    const answeredYes = /\byes\b/.test(lowerText);

    return {
      ok: answeredYes && containsName,
      containsName,
      answeredYes,
      responseText,
      raw: response.raw || null,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message || 'gemini_error',
      responseText: '',
      error: err?.message || String(err),
    };
  }
}

async function verifyGoalRecall(userId, goalKeyword) {
  if (!userId || !goalKeyword) return { ok: false, reason: 'missing args' };
  const profile = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
  const found = profile && String(profile.goalSummary || '').toLowerCase().includes(goalKeyword.toLowerCase());
  const goals = await memoryRetrievalService.retrieveGoalMemories(userId).catch(() => []);
  const present = found || (goals || []).some((g) => String(g.memory || '').toLowerCase().includes(goalKeyword.toLowerCase()));
  return { ok: Boolean(present), present, fromProfile: Boolean(found), goalCount: (goals || []).length };
}

async function verifyIdentityRecall(userId, identityKeyword) {
  if (!userId || !identityKeyword) return { ok: false, reason: 'missing args' };
  const profile = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
  const found = profile && String(profile.identitySummary || '').toLowerCase().includes(identityKeyword.toLowerCase());
  const identities = await memoryRetrievalService.retrieveIdentityMemories(userId).catch(() => []);
  const present = found || (identities || []).some((i) => String(i.memory || '').toLowerCase().includes(identityKeyword.toLowerCase()));
  return { ok: Boolean(present), present, fromProfile: Boolean(found), identityCount: (identities || []).length };
}

async function verifyContinuityRecall(userId, personName) {
  if (!userId || !personName) return { ok: false, reason: 'missing args' };
  const packet = await continuityRestorationEngine.buildContinuityPacket(userId).catch(() => null);
  const foundInPacket = packet && JSON.stringify(packet).toLowerCase().includes(personName.toLowerCase());
  return { ok: Boolean(foundInPacket), foundInPacket, packet };
}

async function verifyProjectRecall(userId, projectKeyword) {
  if (!userId || !projectKeyword) return { ok: false, reason: 'missing args' };
  const profile = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
  const found = profile && String(profile.projectSummary || '').toLowerCase().includes(projectKeyword.toLowerCase());
  const projects = await memoryRetrievalService.retrieveProjectMemories(userId).catch(() => []);
  const present = found || (projects || []).some((p) => String(p.memory || '').toLowerCase().includes(projectKeyword.toLowerCase()));
  return { ok: Boolean(present), present, fromProfile: Boolean(found), projectCount: (projects || []).length };
}

async function runEndToEndTest(userId, text = 'My best friend is Aman.') {
  const personName = extractPersonNameFromText(text);

  const lifecycle = await verifyMemoryLifecycle(userId, text).catch(() => ({ ok: false }));
  const relationship = await verifyRelationshipRecall(userId, personName).catch(() => ({ ok: false }));
  const nameIndex = await memoryNameIndexService.searchByName(userId, personName).catch(() => []);
  const profile = await personProfileService.getPersonProfile(userId, personName).catch(() => null);
  const bootstrap = await sessionBootstrapService.buildSessionBootstrapContext(userId, true).catch(() => null);
  const continuity = await continuityRestorationEngine.buildContinuityPacket(userId).catch(() => null);
  const prompt = await systemPromptBuilderService.buildSystemPrompt(userId).catch(() => ({ systemPrompt: '' }));
  const profileSummary = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
  const bootstrapVerification = await verifyBootstrapCache(userId, personName).catch(() => ({ ok: false }));
  const promptVerification = await verifySystemPrompt(userId, personName).catch(() => ({ ok: false }));
  const geminiPromptVerification = await verifyGeminiPrompt(userId, personName, prompt.systemPrompt || '').catch(() => ({ ok: false, reason: 'gemini_verification_failed' }));

  const checks = {
    mongoSave: Boolean(lifecycle && (lifecycle.relationshipSaved || lifecycle.ltmSaved)),
    relationshipSave: Boolean(lifecycle && lifecycle.relationshipSaved),
    personProfileSave: Boolean(profile),
    nameIndexSave: (nameIndex || []).length > 0,
    bootstrapRebuild: Boolean(bootstrap && (bootstrap.bootstrapContext || bootstrap.selectedMemories || bootstrap.profile)),
    bootstrapCacheVersionValid: Boolean(bootstrapVerification && bootstrapVerification.versionValid),
    bootstrapContainsName: Boolean(bootstrapVerification && bootstrapVerification.bootstrapContainsName),
    bootstrapProfileContainsName: Boolean(bootstrapVerification && bootstrapVerification.profileContainsName),
    continuityRebuild: Boolean(continuity && JSON.stringify(continuity).toLowerCase().includes(personName.toLowerCase())),
    promptContainsName: String(prompt.systemPrompt || '').toLowerCase().includes(personName.toLowerCase()),
    promptVerificationContainsName: Boolean(promptVerification && promptVerification.containsName),
    geminiPromptValidation: Boolean(geminiPromptVerification && geminiPromptVerification.ok),
    geminiResponseIncludesName: Boolean(geminiPromptVerification && geminiPromptVerification.containsName),
    recallReturnsName: Boolean(profileSummary && String(profileSummary.relationshipSummary || '').toLowerCase().includes(personName.toLowerCase())),
  };

  const metrics = {
    relationshipRecallRate: checks.relationshipSave || checks.recallReturnsName || checks.nameIndexSave ? 1.0 : 0.0,
    identityRecallRate: (profileSummary && String(profileSummary.identitySummary || '').length) ? 1.0 : 0.0,
    goalRecallRate: (profileSummary && String(profileSummary.goalSummary || '').length) ? 1.0 : 0.0,
    continuityRecallRate: checks.continuityRebuild ? 1.0 : 0.0,
  };

  const failedChecks = Object.keys(checks).filter((k) => !checks[k]);

  const overallHealth = failedChecks.length === 0 ? 'ok' : (failedChecks.length <= 2 ? 'degraded' : 'fail');

  return {
    ok: failedChecks.length === 0,
    overallHealth,
    checks,
    metrics,
    failedChecks,
    details: {
      lifecycle,
      relationship,
      nameIndex: nameIndex || [],
      profile,
      bootstrap,
      continuity,
      prompt,
      bootstrapVerification,
      promptVerification,
      geminiPromptVerification,
      profileSummary,
    },
  };
}

module.exports = {
  extractPersonNameFromText,
  verifyMemoryLifecycle,
  verifyRelationshipRecall,
  verifyProjectRecall,
  verifyGoalRecall,
  verifyIdentityRecall,
  verifyContinuityRecall,
  verifyBootstrapCache,
  verifySystemPrompt,
  runEndToEndTest,
};
