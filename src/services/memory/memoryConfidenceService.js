const _ = require('lodash');

function scaleAccessCount(accessCount) {
  if (!accessCount) return 0;
  return Math.min(1, Math.log10(accessCount + 1) / 2);
}

function computeConfidenceForDoc(doc = {}) {
  const importance = typeof doc.importanceScore === 'number' ? doc.importanceScore : doc.importance || 0.5;
  const accessFactor = scaleAccessCount(doc.accessCount || 0);
  const strength = typeof doc.memoryStrength === 'number' ? doc.memoryStrength : 1;
  const emotional = typeof doc.emotionalWeight === 'number' ? doc.emotionalWeight : 0;

  // Weighted sum: importance 50%, access 25%, strength 20%, emotional 5%
  const score = (importance * 0.5) + (accessFactor * 0.25) + (Math.min(1, strength) * 0.2) + (emotional * 0.05);
  return Math.max(0, Math.min(1, score));
}

async function markConfidence(Model, id, doc) {
  try {
    const confidence = computeConfidenceForDoc(doc);
    await Model.updateOne({ _id: id }, { $set: { confidence } }).exec();
    return confidence;
  } catch (e) {
    console.warn('markConfidence failed', e);
    return null;
  }
}

module.exports = { computeConfidenceForDoc, markConfidence };
