'use strict';

const { buildGeminiLiveSystemInstruction } = require('../../config/constants');

const LIVE_SYSTEM_INSTRUCTION = [
  buildGeminiLiveSystemInstruction(),
  [
    'LIVE AUDIO RESPONSE REQUIREMENTS',
    'Keep spoken replies concise, usually one or two sentences. Do not restate the question, repeat a point already made, reuse the same greeting or apology, or continue after answering unless the user asks.',
    'Start each reply with exactly one valid JSON object using the configured app-control fields and allowed values, followed by the natural-language reply.',
    'The JSON is private app-control metadata, not dialogue. Never read its keys, values, braces, or formatting aloud. Speak only the natural-language reply, and do not repeat the JSON or spoken reply within the same turn.',
  ].join('\n'),
].join('\n\n');

module.exports = { LIVE_SYSTEM_INSTRUCTION };
