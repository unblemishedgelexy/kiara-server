#!/usr/bin/env node
process.env.CERTIFICATION_MODE = 'true';

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { env } = require('../src/config/env');
const { GEMINI_TEXT_MODEL } = require('../src/config/constants');
const connectDB = require('../src/db/connect');
const redisService = require('../src/services/infrastructure/redisService');
const memoryPipelineService = require('../src/services/memory/memoryPipelineService');
const memoryVerificationService = require('../src/services/memory/memoryVerificationService');
const sessionBootstrapService = require('../src/services/memory/sessionBootstrapService');
const continuityRestorationEngine = require('../src/services/memory/continuityRestorationEngine');
const memoryProfileService = require('../src/services/memory/memoryProfileService');
const sessionMemoryService = require('../src/services/memory/sessionMemoryService');
const conversationStateService = require('../src/services/memory/conversationStateService');
const systemPromptBuilderService = require('../src/services/memory/systemPromptBuilderService');
const bootstrapCacheService = require('../src/services/memory/bootstrapCacheService');
const memoryRetrievalService = require('../src/services/memory/memoryRetrievalService');

function normalizeText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function answerMatches(actual, expected) {
  if (!actual || !expected) return false;
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);
  if (normalizedActual.includes(normalizedExpected)) return true;
  return normalizedExpected
    .split(' ')
    .filter(Boolean)
    .every((token) => normalizedActual.includes(token));
}

function buildGeminiMessageContext({ bootstrap, prompt, continuityPacket, additionalContext }) {
  const parts = [];
  if (bootstrap && bootstrap.bootstrapContext) {
    parts.push(`Bootstrap Context:\n${bootstrap.bootstrapContext}`);
  }
  if (prompt && prompt.systemPrompt) {
    parts.push(`System Prompt:\n${prompt.systemPrompt}`);
  }
  if (continuityPacket) {
    const continuityLines = [];
    if (continuityPacket.bootstrap && continuityPacket.bootstrap.bootstrapContext) {
      continuityLines.push(`Bootstrap Memory:\n${continuityPacket.bootstrap.bootstrapContext}`);
    }
    if (continuityPacket.selectedMemories && continuityPacket.selectedMemories.length) {
      continuityLines.push(
        `Continuity Selected Memories:\n${continuityPacket.selectedMemories
          .slice(0, 20)
          .map((m) => `- ${m.category}: ${m.memory}`)
          .join('\n')}`
      );
    }
    if (continuityPacket.conversationState) {
      continuityLines.push(`Conversation State:\n${JSON.stringify(continuityPacket.conversationState, null, 2)}`);
    }
    if (continuityPacket.activeSession) {
      continuityLines.push(`Active Session Memory:\n${JSON.stringify(continuityPacket.activeSession, null, 2)}`);
    }
    parts.push(continuityLines.filter(Boolean).join('\n\n'));
  }
  if (additionalContext) parts.push(additionalContext);
  return parts.filter(Boolean).join('\n\n');
}

function createGeminiClient() {
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY must be configured to run Gemini session certification');
  }
  return new GoogleGenAI({ apiKey: env.geminiApiKey });
}

async function askGemini(question, messageContext) {
  const ai = createGeminiClient();
  const chat = ai.chats.create({ model: GEMINI_TEXT_MODEL, config: {} , history: [] });
  const prompt = [messageContext, `Question: ${question}`].filter(Boolean).join('\n\n');
  const response = await chat.sendMessage({
    message: prompt,
    config: {
      temperature: 0.1,
      maxOutputTokens: 256,
    },
  });

  const text = response.text || (response.candidates && response.candidates[0] && response.candidates[0].content) || '';
  return String(text || '').trim();
}

async function waitForMemoryProfile(userId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const profile = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
    if (profile && (profile.identitySummary || profile.relationshipSummary || profile.projectSummary || profile.goalSummary || profile.preferenceSummary)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function processMessages(userId, sessionId, messages) {
  for (const msg of messages) {
    await memoryPipelineService.enqueueOrProcessMessage({ userId, sessionId, text: msg, role: 'user' });
  }
  await memoryProfileService.rebuildMemoryProfile(userId).catch(() => null);
  await waitForMemoryProfile(userId, 10000).catch(() => null);
}

async function runScenario({ userId, initialMessages, question, expectedAnswer, verifyFn, expectedMemoryPhrase, sessionRebuild, continuityQuestion, continuityExpected }) {
  const sessionId = `gemini-cert-${userId}`;
  await processMessages(userId, sessionId, initialMessages);

  const memoryStored = Boolean(await verifyFn());

  const bootstrap = await sessionBootstrapService.buildSessionBootstrapContext(userId, true).catch(() => null);
  const bootstrapContains = bootstrap && normalizeText(JSON.stringify(bootstrap)).includes(normalizeText(expectedMemoryPhrase));

  const prompt = await systemPromptBuilderService.buildSystemPrompt(userId).catch(() => ({ systemPrompt: '' }));
  const promptContains = normalizeText(prompt.systemPrompt).includes(normalizeText(expectedMemoryPhrase));

  let continuityPacket = null;
  let continuityContains = false;
  if (sessionRebuild || continuityQuestion) {
    if (sessionRebuild) {
      await sessionMemoryService.deleteActiveSessionMemory(userId).catch(() => null);
    }
    continuityPacket = await continuityRestorationEngine.buildContinuityPacket(userId, {
      forceRefresh: true,
      totalBudget: 1200,
      userMessage: continuityQuestion || question,
    }).catch(() => null);
    continuityContains = normalizeText(JSON.stringify(continuityPacket)).includes(normalizeText(continuityExpected || expectedMemoryPhrase));
  }

  const messageContext = buildGeminiMessageContext({ bootstrap, prompt, continuityPacket, additionalContext: null });
  let geminiAnswer = '';
  let geminiAnswerCorrect = false;
  try {
    geminiAnswer = await askGemini(question, messageContext);
    geminiAnswerCorrect = answerMatches(geminiAnswer, expectedAnswer);
  } catch (error) {
    geminiAnswer = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    geminiAnswerCorrect = false;
  }

  return {
    userId,
    question,
    expectedAnswer,
    memoryStored,
    bootstrapContains,
    promptContains,
    continuityContains,
    geminiAnswer,
    geminiAnswerCorrect,
    continuityPacket,
    bootstrap,
    prompt,
  };
}

async function run() {
  await connectDB();
  await redisService.initRedis();

  const scenarios = [];

  scenarios.push({
    name: 'IDENTITY',
    userId: 'gemini-cert-identity',
    initialMessages: ['My name is Roshan.'],
    question: 'What is my name?',
    expectedAnswer: 'Roshan',
    verifyFn: async () => {
      const recall = await memoryVerificationService.verifyIdentityRecall('gemini-cert-identity', 'Roshan').catch(() => ({ ok: false }));
      return Boolean(recall && recall.ok);
    },
    expectedMemoryPhrase: 'Roshan',
  });

  scenarios.push({
    name: 'RELATIONSHIP',
    userId: 'gemini-cert-relationship',
    initialMessages: ['My best friend is Aman.'],
    question: 'Who is my best friend?',
    expectedAnswer: 'Aman',
    verifyFn: async () => {
      const recall = await memoryVerificationService.verifyRelationshipRecall('gemini-cert-relationship', 'Aman').catch(() => ({ ok: false }));
      return Boolean(recall && recall.ok);
    },
    expectedMemoryPhrase: 'Aman',
  });

  scenarios.push({
    name: 'PREFERENCE',
    userId: 'gemini-cert-preference',
    initialMessages: ['I like dark mode.'],
    question: 'What do I like?',
    expectedAnswer: 'dark mode',
    verifyFn: async () => {
      const preferences = await memoryRetrievalService.retrievePreferenceMemories('gemini-cert-preference').catch(() => []);
      return preferences.some((m) => normalizeText(m.memory).includes('dark mode'));
    },
    expectedMemoryPhrase: 'dark mode',
  });

  scenarios.push({
    name: 'PROJECT',
    userId: 'gemini-cert-project',
    initialMessages: ['I am building Kiara AI.'],
    question: 'What project am I working on?',
    expectedAnswer: 'Kiara AI',
    verifyFn: async () => {
      const recall = await memoryVerificationService.verifyProjectRecall('gemini-cert-project', 'Kiara AI').catch(() => ({ ok: false }));
      return Boolean(recall && recall.ok);
    },
    expectedMemoryPhrase: 'Kiara AI',
  });

  scenarios.push({
    name: 'GOAL',
    userId: 'gemini-cert-goal',
    initialMessages: ['My goal is to build the best AI assistant.'],
    question: 'What is my goal?',
    expectedAnswer: 'best AI assistant',
    verifyFn: async () => {
      const recall = await memoryVerificationService.verifyGoalRecall('gemini-cert-goal', 'best AI assistant').catch(() => ({ ok: false }));
      return Boolean(recall && recall.ok);
    },
    expectedMemoryPhrase: 'best AI assistant',
  });

  scenarios.push({
    name: 'SESSION CONTINUITY',
    userId: 'gemini-cert-continuity',
    initialMessages: ['Today we discussed Memory V7.'],
    question: 'What were we discussing before?',
    expectedAnswer: 'Memory V7',
    verifyFn: async () => {
      const continuity = await memoryVerificationService.verifyContinuityRecall('gemini-cert-continuity', 'Memory V7').catch(() => ({ ok: false }));
      return Boolean(continuity && continuity.ok);
    },
    expectedMemoryPhrase: 'Memory V7',
    sessionRebuild: true,
    continuityQuestion: 'What were we discussing before?',
    continuityExpected: 'Memory V7',
  });

  scenarios.push({
    name: 'LONG TERM RECALL',
    userId: 'gemini-cert-longterm',
    initialMessages: ['My name is Roshan.'],
    question: 'What is my name?',
    expectedAnswer: 'Roshan',
    verifyFn: async () => {
      const recall = await memoryVerificationService.verifyIdentityRecall('gemini-cert-longterm', 'Roshan').catch(() => ({ ok: false }));
      return Boolean(recall && recall.ok);
    },
    expectedMemoryPhrase: 'Roshan',
    fillerCount: 1000,
  });

  scenarios.push({
    name: 'CONTEXTUAL RECALL',
    userId: 'gemini-cert-contextual',
    initialMessages: ['My best friend is Aman.', 'Aman helped me with coding.'],
    question: 'Tell me about Aman.',
    expectedAnswer: 'best friend',
    verifyFn: async () => {
      const recall = await memoryVerificationService.verifyRelationshipRecall('gemini-cert-contextual', 'Aman').catch(() => ({ ok: false }));
      return Boolean(recall && recall.ok);
    },
    expectedMemoryPhrase: 'Aman',
  });

  const results = [];
  for (const scenario of scenarios) {
    console.log(`[CERT] Running ${scenario.name}`);

    if (scenario.fillerCount) {
      await processMessages(scenario.userId, `gemini-cert-${scenario.userId}`, scenario.initialMessages);
      for (let i = 0; i < scenario.fillerCount; i += 1) {
        await memoryPipelineService.enqueueOrProcessMessage({
          userId: scenario.userId,
          sessionId: `gemini-cert-${scenario.userId}-filler`,
          text: `Filler memory number ${i + 1} for long term recall certification.`,
          role: 'user',
        });
      }
      await memoryProfileService.rebuildMemoryProfile(scenario.userId).catch(() => null);
      await waitForMemoryProfile(scenario.userId, 15000).catch(() => null);
    }

    const result = await runScenario({
      userId: scenario.userId,
      initialMessages: scenario.fillerCount ? [] : scenario.initialMessages,
      question: scenario.question,
      expectedAnswer: scenario.expectedAnswer,
      verifyFn: scenario.verifyFn,
      expectedMemoryPhrase: scenario.expectedMemoryPhrase,
      sessionRebuild: scenario.sessionRebuild,
      continuityQuestion: scenario.continuityQuestion,
      continuityExpected: scenario.continuityExpected,
    }).catch((err) => ({
      userId: scenario.userId,
      question: scenario.question,
      expectedAnswer: scenario.expectedAnswer,
      error: err instanceof Error ? err.message : String(err),
      memoryStored: false,
      bootstrapContains: false,
      promptContains: false,
      continuityContains: false,
      geminiAnswer: '',
      geminiAnswerCorrect: false,
    }));

    results.push({ name: scenario.name, ...result });
  }

  const memoryMetrics = ['IDENTITY', 'RELATIONSHIP', 'PREFERENCE', 'PROJECT', 'GOAL'];
  const memoryAccuracy = results
    .filter((r) => memoryMetrics.includes(r.name))
    .reduce((sum, r) => sum + (r.geminiAnswerCorrect ? 1 : 0), 0) / memoryMetrics.length * 100;

  const continuityMetrics = results.filter((r) => ['SESSION CONTINUITY'].includes(r.name));
  const continuityScore = continuityMetrics.length
    ? continuityMetrics.reduce((sum, r) => sum + (r.geminiAnswerCorrect ? 1 : 0), 0) / continuityMetrics.length * 100
    : 0;

  const recallMetrics = results.filter((r) => ['LONG TERM RECALL', 'CONTEXTUAL RECALL'].includes(r.name));
  const recallScore = recallMetrics.length
    ? recallMetrics.reduce((sum, r) => sum + (r.geminiAnswerCorrect ? 1 : 0), 0) / recallMetrics.length * 100
    : 0;

  const overallPass = memoryAccuracy >= 95 && continuityScore >= 95 && recallScore >= 95;

  const lines = [];
  lines.push('# GEMINI SESSION CERTIFICATION');
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Gemini Memory Accuracy: ${memoryAccuracy.toFixed(2)}%`);
  lines.push(`- Gemini Continuity: ${continuityScore.toFixed(2)}%`);
  lines.push(`- Gemini Recall: ${recallScore.toFixed(2)}%`);
  lines.push(`- Overall Result: ${overallPass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('## Scenario Results');
  for (const result of results) {
    lines.push(`### ${result.name}`);
    lines.push(`- Memory Stored: ${result.memoryStored ? 'YES' : 'NO'}`);
    lines.push(`- Bootstrap Contains Memory: ${result.bootstrapContains ? 'YES' : 'NO'}`);
    lines.push(`- Prompt Contains Memory: ${result.promptContains ? 'YES' : 'NO'}`);
    if (result.continuityPacket) {
      lines.push(`- Continuity Contains Memory: ${result.continuityContains ? 'YES' : 'NO'}`);
    }
    lines.push(`- Gemini Answer Correct: ${result.geminiAnswerCorrect ? 'YES' : 'NO'}`);
    lines.push(`- Gemini Answer: ${result.geminiAnswer}`);
    lines.push('');
  }

  const outputPath = path.resolve(__dirname, '..', 'GEMINI_SESSION_CERTIFICATION.md');
  fs.writeFileSync(outputPath, lines.join('\n'));
  console.log(`Wrote certification report to ${outputPath}`);
  console.log(`Memory Accuracy: ${memoryAccuracy.toFixed(2)}%, Continuity: ${continuityScore.toFixed(2)}%, Recall: ${recallScore.toFixed(2)}%`);
  console.log(`Overall Result: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exit(overallPass ? 0 : 1);
}

run().catch((err) => {
  console.error('Certification run failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
