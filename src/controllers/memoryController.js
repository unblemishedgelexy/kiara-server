const memoryService = require('../services/memoryService');
const stmToLtmConverter = require('../services/stmToLtmConverter');

async function addShort(req, res, next) {
  try {
    const { sessionId, role, message } = req.body;
    const userId = req.userId;
    const doc = await memoryService.addShortTerm({ userId, sessionId, role, message });
    res.json({ success: true, message: 'Short term memory added', data: doc });
  } catch (err) { next(err); }
}

async function getShort(req, res, next) {
  try {
    const { sessionId } = req.params;
    const userId = req.userId;
    const docs = await memoryService.getShortTerm(userId, sessionId);
    res.json({ success: true, data: docs });
  } catch (err) { next(err); }
}

async function deleteShort(req, res, next) {
  try {
    const { sessionId } = req.params;
    const userId = req.userId;
    await memoryService.deleteShortTerm(userId, sessionId);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { next(err); }
}

async function analyzeLong(req, res, next) {
  try {
    const { text } = req.body;
    const userId = req.userId;
    const result = await memoryService.analyzeAndSaveLongTerm({ userId, text });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function getLong(req, res, next) {
  try {
    const userId = req.userId;
    const docs = await memoryService.getLongTerm(userId);
    res.json({ success: true, data: docs });
  } catch (err) { next(err); }
}

async function deleteLong(req, res, next) {
  try {
    const { id } = req.params;
    await memoryService.deleteLongTerm(id);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { next(err); }
}

async function patchLong(req, res, next) {
  try {
    const { id } = req.params;
    const updated = await memoryService.patchLongTerm(id, req.body);
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
}

async function searchLong(req, res, next) {
  try {
    const userId = req.userId;
    const { query } = req.query;
    if (!query || !query.trim()) {
      return res.json({ success: true, data: [] });
    }
    const results = await memoryService.searchLongTermVectors(userId, query.trim());
    res.json({ success: true, data: results });
  } catch (err) { next(err); }
}

async function promoteStmSession(req, res, next) {
  try {
    const userId = req.userId;
    const { sessionId } = req.params;
    const result = await stmToLtmConverter.manualPromoteSession(userId, sessionId);
    res.json({ success: result.success, data: result });
  } catch (err) { next(err); }
}

async function promoteAllStm(req, res, next) {
  try {
    const userId = req.userId;
    const stats = await stmToLtmConverter.promoteStmToLtm(userId);
    res.json({
      success: true,
      data: stats,
      message: `Promoted ${stats.promoted} memories to LTM`,
    });
  } catch (err) { next(err); }
}

async function getContext(req, res, next) {
  try {
    const userId = req.userId;
    const { chatId } = req.query;
    const snapshot = await memoryService.getMemorySnapshot(userId, chatId);
    res.json({ success: true, data: snapshot });
  } catch (err) { next(err); }
}

async function saveMessage(req, res, next) {
  try {
    const userId = req.userId;
    const { chatId, role, text } = req.body;
    const result = await memoryService.saveRealtimeMessage({ userId, chatId, role, text });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

module.exports = {
  addShort,
  getShort,
  deleteShort,
  analyzeLong,
  getLong,
  deleteLong,
  patchLong,
  searchLong,
  promoteStmSession,
  promoteAllStm,
  getContext,
  saveMessage,
};
