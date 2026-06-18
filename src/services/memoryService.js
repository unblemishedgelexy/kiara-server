const mongoose = require('mongoose');
const { MEMORY_RECENT_MESSAGE_LIMIT, MEMORY_SUMMARY_BATCH_SIZE, MEMORY_SUMMARY_TRIGGER } = require('../config/constants');
const ChatModel = require('../models/Chat');
const MessageModel = require('../models/Message');
const SummaryModel = require('../models/Summary');
const LongTermMemory = require('../models/LongTermMemory');
const { summarizeConversation, analyzeConversation } = require('./geminiService');
const { encrypt, decrypt } = require('../utils/crypto');
const redisService = require('./redisService');
const pineconeService = require('./pineconeService');
const memoryRetrievalService = require('./memoryRetrievalService');
const ConversationState = require('../models/ConversationState');
const sessionMemoryService = require('./sessionMemoryService');
const { env } = require('../config/env');

async function getOrCreateChat(userId, chatId) {
  if (chatId) {
    const existingChat = await ChatModel.findOne({ _id: chatId, userId });
    if (existingChat) return existingChat;
  }
  const latestChat = await ChatModel.findOne({ userId }).sort({ lastMessageAt: -1 });
  if (latestChat) return latestChat;
  return ChatModel.create({ userId });
}

async function saveRealtimeMessage(input) {
  const chat = await getOrCreateChat(input.userId, input.chatId);
  const message = await MessageModel.create({ chatId: chat._id, content: input.text.trim(), role: input.role, userId: input.userId });
  chat.lastMessageAt = new Date();
  await chat.save();
  await maybeRefreshSummary(chat._id, input.userId);
  return { chatId: String(chat._id), messageId: String(message._id) };
}

async function getMemorySnapshot(userId, chatId) {
  const chat = await getOrCreateChat(userId, chatId);
  const latestSummary = await SummaryModel.findOne({ chatId: chat._id, userId }).sort({ upToMessageCreatedAt: -1 });
  const recentMessages = await MessageModel.find({ chatId: chat._id, createdAt: latestSummary ? { $gt: latestSummary.upToMessageCreatedAt } : undefined, userId })
    .sort({ createdAt: -1 })
    .limit(MEMORY_RECENT_MESSAGE_LIMIT)
    .lean();

  const identityMemories = await memoryRetrievalService.retrieveIdentityMemories(userId);
  const preferenceMemories = await memoryRetrievalService.retrievePreferenceMemories(userId);
  const relationshipMemories = await memoryRetrievalService.retrieveRelationshipMemories(userId);
  const projectMemories = await memoryRetrievalService.retrieveProjectMemories(userId);
  const goalMemories = await memoryRetrievalService.retrieveGoalMemories(userId);
  const relevantLongTermMemories = await memoryRetrievalService.retrieveRelevantMemories(userId);

  return {
    chatId: String(chat._id),
    summary: latestSummary ? latestSummary.content : '',
    turns: recentMessages.reverse().map((message) => ({ createdAt: message.createdAt.getTime(), id: String(message._id), role: message.role, text: message.content })),
    identityMemories,
    preferenceMemories,
    relationshipMemories,
    projectMemories,
    goalMemories,
    relevantLongTermMemories,
  };
}

async function maybeRefreshSummary(chatId, userId) {
  const latestSummary = await SummaryModel.findOne({ chatId, userId }).sort({ upToMessageCreatedAt: -1 });
  const unsummarizedMessages = await MessageModel.find({ chatId, createdAt: latestSummary ? { $gt: latestSummary.upToMessageCreatedAt } : undefined, userId }).sort({ createdAt: 1 }).limit(MEMORY_SUMMARY_BATCH_SIZE).lean();
  if (unsummarizedMessages.length < MEMORY_SUMMARY_TRIGGER) return;
  const transcript = unsummarizedMessages.map((message) => `${message.role === 'assistant' ? 'Kiara' : 'User'}: ${message.content}`).join('\n');
  const content = await summarizeConversation({ existingSummary: latestSummary ? latestSummary.content : undefined, transcript });
  const lastMessage = unsummarizedMessages.at(-1);
  if (!lastMessage) return;
  await SummaryModel.create({ chatId, content, upToMessageCreatedAt: lastMessage.createdAt, userId });
}

function normalizeTextForEmbedding(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function createTextEmbedding(text, dimension = env.pineconeVectorDimension || 128) {
  const normalized = normalizeTextForEmbedding(text);
  const vector = new Array(dimension).fill(0);

  for (let i = 0; i < normalized.length; i += 1) {
    const charCode = normalized.charCodeAt(i);
    vector[i % dimension] += ((charCode % 31) + 1) * 0.1;
  }

  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

async function persistLongTermToPinecone(doc, analysis) {
  if (!pineconeService.isPineconeConfigured()) {
    return;
  }

  const vector = createTextEmbedding(analysis.memory);
  const metadata = {
    userId: String(doc.userId),
    category: doc.category,
    importanceScore: doc.importanceScore,
    tags: Array.isArray(doc.tags) ? doc.tags.join(',') : '',
    contentPreview: analysis.memory.slice(0, 1000),
    createdAt: doc.createdAt.toISOString(),
  };

  try {
    await pineconeService.upsertLongTermVector({ id: String(doc._id), vector, metadata });
  } catch (error) {
    console.warn('Failed to persist long-term memory to Pinecone:', error);
  }
}

async function addShortTerm({ userId, sessionId, role, message }) {
  return redisService.saveShortTermMemory(userId, sessionId, role, message);
}

async function getShortTerm(userId, sessionId) {
  return redisService.getShortTermMemory(userId, sessionId);
}

async function deleteShortTerm(userId, sessionId) {
  return redisService.deleteShortTermMemory(userId, sessionId);
}

async function analyzeAndSaveLongTerm({ userId, text }) {
  const analysis = await analyzeConversation(text);
  if (!analysis.shouldStore) return { stored: false, analysis };
  const encrypted = encrypt(analysis.memory);
  const doc = await LongTermMemory.create({
    userId,
    category: analysis.category,
    encryptedMemory: encrypted,
    tags: analysis.tags || [],
    importanceScore: analysis.importanceScore || 0,
  });

  await persistLongTermToPinecone(doc, analysis);
  return { stored: true, doc, analysis };
}

async function getLongTerm(userId) {
  const docs = await LongTermMemory.find({ userId }).sort({ importanceScore: -1 });
  return docs.map((d) => ({
    id: d._id,
    category: d.category,
    memory: decrypt(d.encryptedMemory),
    tags: d.tags,
    importanceScore: d.importanceScore,
  }));
}

async function searchLongTermVectors(userId, query) {
  if (!pineconeService.isPineconeConfigured()) {
    return [];
  }

  try {
    const queryVector = createTextEmbedding(query);
    const matches = await pineconeService.queryLongTermVectors({
      vector: queryVector,
      topK: 10,
      filter: { userId: { $eq: String(userId) } },
    });

    return matches.map((match) => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata,
    }));
  } catch (error) {
    console.warn('Failed to search long-term memory vectors:', error);
    return [];
  }
}

async function deleteLongTerm(id) {
  const deleted = await LongTermMemory.findByIdAndDelete(id);
  if (deleted && pineconeService.isPineconeConfigured()) {
    try {
      await pineconeService.deleteLongTermVector(String(id));
    } catch (error) {
      console.warn('Failed to delete long-term memory from Pinecone:', error);
    }
  }
  return deleted;
}

async function patchLongTerm(id, patch) {
  const updatedMemory = patch.memory;

  if (typeof updatedMemory === 'string') {
    patch.encryptedMemory = encrypt(updatedMemory);
    delete patch.memory;
  }

  const updated = await LongTermMemory.findByIdAndUpdate(
    { _id: id },
    { ...patch, updatedAt: new Date() },
    { returnDocument: 'after' }
  );

  if (updated && updatedMemory && pineconeService.isPineconeConfigured()) {
    const metadata = {
      userId: String(updated.userId),
      category: updated.category,
      importanceScore: updated.importanceScore,
      tags: Array.isArray(updated.tags) ? updated.tags.join(',') : '',
      contentPreview: updatedMemory.slice(0, 1000),
      updatedAt: updated.updatedAt.toISOString(),
    };

    try {
      await pineconeService.upsertLongTermVector({
        id: String(updated._id),
        vector: createTextEmbedding(updatedMemory),
        metadata,
      });
    } catch (error) {
      console.warn('Failed to update long-term memory in Pinecone:', error);
    }
  }

  return updated;
}

async function getMemoryDiagnostics(userId) {
  const diagnostics = {
    chats: 0,
    summaries: 0,
    shortTermCount: 0,
    longTermCount: 0,
    identityCount: 0,
    preferenceCount: 0,
    relationshipCount: 0,
    projectCount: 0,
    goalCount: 0,
    pineconeConfigured: pineconeService.isPineconeConfigured(),
    redisConnected: false,
    mongoConnected: mongoose.connection.readyState === 1,
  };

  try {
    diagnostics.chats = await ChatModel.countDocuments({ userId });
    diagnostics.summaries = await SummaryModel.countDocuments({ userId });
    diagnostics.longTermCount = await LongTermMemory.countDocuments({ userId });
    diagnostics.identityCount = await LongTermMemory.countDocuments({ userId, category: { $in: ['identity'] } });
    diagnostics.preferenceCount = await LongTermMemory.countDocuments({ userId, category: { $in: ['preference', 'preferences'] } });
    diagnostics.relationshipCount = await LongTermMemory.countDocuments({ userId, category: { $in: ['relationship', 'relationships'] } });
    diagnostics.projectCount = await LongTermMemory.countDocuments({ userId, category: { $in: ['project', 'projects'] } });
    diagnostics.goalCount = await LongTermMemory.countDocuments({ userId, category: { $in: ['goal', 'goals'] } });

    const client = await redisService.getRedisClient();
    if (client) {
      diagnostics.redisConnected = true;
      const keys = await client.keys(`memory:short:${userId}:*`);
      diagnostics.shortTermCount = keys.length;
    }
    // Conversation state
    try {
      const state = await ConversationState.findOne({ userId }).sort({ updatedAt: -1 }).lean();
      diagnostics.conversationState = state || null;
    } catch (e) {
      diagnostics.conversationState = null;
    }
    // Active session memory sample
    try {
      const active = await sessionMemoryService.getActiveSessionMemory(userId, 'default');
      diagnostics.activeSessionMemory = active || null;
    } catch (e) {
      diagnostics.activeSessionMemory = null;
    }
  } catch (error) {
    console.warn('Memory diagnostics warning:', error);
  }

  return diagnostics;
}

function truncateText(text, maxChars) {
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

async function buildMemoryContext(userId, chatId, query) {
  const snapshot = await getMemorySnapshot(userId, chatId);
  const memoryQuery = typeof query === 'string' ? query : '';
  const relevantLongTermMemories = await memoryRetrievalService.retrieveRelevantMemories(userId, memoryQuery);

  const contextPieces = [];

  if (snapshot.summary) {
    contextPieces.push(`Summary:\n${truncateText(snapshot.summary, 1200)}`);
  }

  if (snapshot.turns.length) {
    const turnsText = snapshot.turns.slice(-10).map((turn) => `${turn.role}: ${truncateText(turn.text, 300)}`).join('\n');
    contextPieces.push(`Recent conversation turns:\n${turnsText}`);
  }

  const addCategories = (label, memories) => {
    if (!memories || memories.length === 0) return;
    const section = memories.slice(0, 5).map((m) => `- (${m.importanceScore.toFixed(2)}) ${truncateText(m.memory, 260)}`).join('\n');
    contextPieces.push(`${label}:\n${section}`);
  };

  addCategories('Identity memories', snapshot.identityMemories);
  addCategories('Preference memories', snapshot.preferenceMemories);
  addCategories('Relationship memories', snapshot.relationshipMemories);
  addCategories('Project memories', snapshot.projectMemories);
  addCategories('Goal memories', snapshot.goalMemories);
  addCategories('Relevant long-term memories', relevantLongTermMemories);

  const prompt = [`Use the following memory context to answer user queries.`,
    `Do not invent new facts.`,
    `Only use the most important memories relevant to this conversation.`,
    `Memory context:`,
    contextPieces.join('\n\n')].join('\n\n');

  return {
    ...snapshot,
    relevantLongTermMemories,
    memoryContext: contextPieces,
    prompt,
  };
}

module.exports = {
  getOrCreateChat,
  saveRealtimeMessage,
  getMemorySnapshot,
  addShortTerm,
  getShortTerm,
  deleteShortTerm,
  analyzeAndSaveLongTerm,
  getLongTerm,
  deleteLongTerm,
  patchLongTerm,
  searchLongTermVectors,
  getMemoryDiagnostics,
  buildMemoryContext,
};
