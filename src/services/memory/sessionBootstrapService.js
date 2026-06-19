const { env } = require('../../config/env');
const memoryProfileService = require('./memoryProfileService');
const profileCompressionService = require('../infrastructure/profileCompressionService');
const bootstrapMemorySelector = require('./bootstrapMemorySelector');
const conversationStateService = require('./conversationStateService');
const sessionMemoryService = require('./sessionMemoryService');
const sessionResumeService = require('./sessionResumeService');
const bootstrapCacheService = require('./bootstrapCacheService');

async function buildBootstrapPayload(userId) {
	const profile = await memoryProfileService.getMemoryProfile(userId);
	const compressed = profileCompressionService.compressProfile(profile);
	const selectedMemories = await bootstrapMemorySelector.selectBootstrapMemories(
		userId,
		20,
		[profile?.identitySummary, profile?.preferenceSummary, profile?.relationshipSummary, profile?.projectSummary, profile?.goalSummary]
			.filter(Boolean)
			.join(' ')
	);
	const [conversationState, activeSession] = await Promise.all([
		conversationStateService.getConversationState(userId),
		sessionMemoryService.getActiveSessionMemory(userId),
	]);
	const resumeArgs = await sessionResumeService.getResumeContext(userId);
	const resumeContext = sessionResumeService.buildResumeContext(resumeArgs);

	const contextPieces = [];
	if (compressed.compressedProfile) {
		contextPieces.push(`Profile Summary:\n${compressed.compressedProfile}`);
	}
	if (resumeContext) {
		contextPieces.push(`Resume Context:\n${resumeContext}`);
	}
	if (selectedMemories?.length) {
		contextPieces.push(
			`Selected Memories:\n${selectedMemories.slice(0, 20).map((memory) => `- ${memory.category}: ${memory.memory}`).join('\n')}`
		);
	}

	const bootstrapContext = contextPieces.filter(Boolean).join('\n\n').trim();
	return {
		bootstrapContext,
		resumeContext,
		selectedMemories,
		profile,
		compressedProfile: compressed.compressedProfile,
		profileTokenCount: compressed.tokenCount,
		conversationState,
		activeSession,
		bootstrapVersion: env.bootstrapVersion,
		lastUpdated: new Date().toISOString(),
	};
}

async function buildSessionBootstrapContext(userId, forceRefresh = false) {
	if (!userId) return null;

	if (!forceRefresh) {
		const cached = await bootstrapCacheService.getBootstrapContext(userId);
		if (cached && cached.bootstrapVersion === env.bootstrapVersion) {
			return { cached: true, ...cached };
		}
	}

	const payload = await buildBootstrapPayload(userId);
	await bootstrapCacheService.saveBootstrapContext(userId, payload);
	return { cached: false, ...payload };
}

module.exports = { buildSessionBootstrapContext };
