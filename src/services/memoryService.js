const { MEMORY_RECENT_MESSAGE_LIMIT, MEMORY_SUMMARY_BATCH_SIZE, MEMORY_SUMMARY_TRIGGER } = require('../config/constants');
const ChatModel = require('../models/Chat');
const MessageModel = require('../models/Message');
const SummaryModel = require('../models/Summary');
const { summarizeConversation } = require('./geminiService');

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
  const recentMessages = await MessageModel.find({ chatId: chat._id, createdAt: latestSummary ? { $gt: latestSummary.upToMessageCreatedAt } : undefined, userId }).sort({ createdAt: -1 }).limit(MEMORY_RECENT_MESSAGE_LIMIT).lean();
  return { chatId: String(chat._id), summary: latestSummary ? latestSummary.content : '', turns: recentMessages.reverse().map((message) => ({ createdAt: message.createdAt.getTime(), id: String(message._id), role: message.role, text: message.content })) };
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

const ShortTermMemory = require('../models/ShortTermMemory');
const LongTermMemory = require('../models/LongTermMemory');
const { analyzeConversation } = require('./geminiService');
const { encrypt, decrypt } = require('../utils/crypto');

async function addShortTerm({ userId, sessionId, role, message, ttlSeconds = 900 }) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  return ShortTermMemory.create({ userId, sessionId, role, message, expiresAt });
}

async function getShortTerm(sessionId) {
  return ShortTermMemory.find({ sessionId }).sort({ timestamp: 1 });
}

async function deleteShortTerm(sessionId) {
  return ShortTermMemory.deleteMany({ sessionId });
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

async function deleteLongTerm(id) {
  return LongTermMemory.findByIdAndDelete(id);
}

async function patchLongTerm(id, patch) {
  if (patch.memory) patch.encryptedMemory = encrypt(patch.memory);
  return LongTermMemory.findByIdAndUpdate({ _id: id }, { ...patch, updatedAt: new Date() }, { returnDocument: 'after' });
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
};
