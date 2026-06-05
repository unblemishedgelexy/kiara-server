const memoryService = require('../services/memoryService');

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
    const docs = await memoryService.getShortTerm(sessionId);
    res.json({ success: true, data: docs });
  } catch (err) { next(err); }
}

async function deleteShort(req, res, next) {
  try {
    const { sessionId } = req.params;
    await memoryService.deleteShortTerm(sessionId);
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
  getContext,
  saveMessage,
};
