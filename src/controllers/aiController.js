const { generateText } = require('../services/../services/live/geminiService');

async function generateTextController(req, res, next) {
  try {
    const { prompt, model, temperature, candidateCount, maxOutputTokens } = req.body;
    const result = await generateText({ prompt, model, temperature, candidateCount, maxOutputTokens });
    res.json({ success: true, data: { text: result.text, raw: result.raw } });
  } catch (err) {
    next(err);
  }
}

module.exports = { generateTextController };
