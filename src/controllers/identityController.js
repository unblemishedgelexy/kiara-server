const multer = require('multer');
const realIdentityService = require('../services/../services/infrastructure/realIdentityService');

const upload = multer({ storage: multer.memoryStorage() });

/**
 * Recognize face - extract descriptor from frontend and match
 */
async function recognizeFaceController(req, res, next) {
  try {
    const userId = req.userId; // From auth middleware
    const { face_descriptor } = req.body;

    if (!face_descriptor || !Array.isArray(face_descriptor)) {
      return res.status(400).json({ error: 'Invalid face descriptor' });
    }

    const result = await realIdentityService.recognizeFace(userId, face_descriptor);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Recognize voice - extract descriptor from frontend and match
 */
async function recognizeVoiceController(req, res, next) {
  try {
    const userId = req.userId; // From auth middleware
    const { voice_descriptor, voice_characteristics } = req.body;

    if (!voice_descriptor || !Array.isArray(voice_descriptor)) {
      return res.status(400).json({ error: 'Invalid voice descriptor' });
    }

    const result = await realIdentityService.recognizeVoice(userId, voice_descriptor, voice_characteristics);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Process interaction with face and/or voice embeddings
 */
async function processInteractionController(req, res, next) {
  try {
    const userId = req.userId; // From auth middleware
    const { face_embedding, voice_embedding, voice_characteristics, interaction_context } = req.body;

    const result = await realIdentityService.processInteraction(
      userId,
      face_embedding,
      voice_embedding,
      voice_characteristics,
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Learn/register a new person
 */
async function learnPersonController(req, res, next) {
  try {
    const userId = req.userId; // From auth middleware
    const {
      person_id,
      name,
      relationship,
      face_descriptor,
      voice_descriptor,
      voice_characteristics,
    } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }

      // Server-side validation: accept learning only when the provided name
      // is expressed in a clear declarative identity statement.
      // This prevents accidental learning from single-word utterances
      // such as "Chiara" or other non-declarative input.
      const rawName = String(name || '').trim();

      // Allowed declaration patterns (capture the actual name)
      const patterns = [
        /\bmy name(?:'s| is)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{0,50})/i,
        /\b(?:mera naam(?: hai)?|naam hai|mera naam)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{0,50})/i,
        /\b(?:call me|you can call me|people call me)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{0,50})/i,
        /\b(?:i am|i'm)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{0,50})/i,
        /\b(?:mujhe)\s+([A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F\s'’.-]{0,50})\s*bulao/i,
      ];

      let extractedName = null;
      for (const re of patterns) {
        const m = rawName.match(re);
        if (m && m[1]) {
          extractedName = m[1].trim();
          break;
        }
      }

      if (!extractedName) {
        return res.json({
          success: false,
          learned: false,
          reason: 'no explicit identity declaration',
        });
      }

      const finalName = extractedName;

    const result = await realIdentityService.learnPerson(
      userId,
      person_id,
      finalName,
      relationship || 'guest',
      face_descriptor,
      voice_descriptor,
      voice_characteristics,
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Get all known people for user
 */
async function listPeopleController(req, res, next) {
  try {
    const userId = req.userId; // From auth middleware
    const result = await realIdentityService.getPeopleForUser(userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Get identity system statistics
 */
async function getStatsController(req, res, next) {
  try {
    const userId = req.userId; // From auth middleware

    // Get user's profiles
    const PersonProfile = require('../models/PersonProfile');
    const profiles = await PersonProfile.find({ userId });

    const stats = {
      total_people: profiles.length,
      total_with_face: profiles.filter((p) => p.faceDescriptor).length,
      total_with_voice: profiles.filter((p) => p.voiceDescriptor).length,
      total_learned: profiles.filter((p) => p.isLearned).length,
      avg_meetings_count: profiles.length > 0 ? Math.round(profiles.reduce((sum, p) => sum + p.meetingsCount, 0) / profiles.length) : 0,
      face_embedding_dim: 128, // face-api standard
      voice_embedding_dim: 13, // MFCC coefficient count
    };

    res.json(stats);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  recognizeFaceController,
  recognizeVoiceController,
  processInteractionController,
  learnPersonController,
  listPeopleController,
  getStatsController,
  upload,
};
