/**
 * Real Identity Service - Backend
 * Actually matches faces and voices against stored profiles
 */

const PersonProfile = require('../models/PersonProfile');
const { cosineSimilarity } = require('../utils/vectorMath');

const FACE_THRESHOLD = 0.55; // 55% similarity threshold for face
const VOICE_THRESHOLD = 0.50; // 50% similarity threshold for voice
const COMBINED_THRESHOLD = 0.65; // 65% for combined match

/**
 * Extract real embeddings from frontend data
 */
async function processEmbedding(embeddingData, type) {
  if (!embeddingData || !Array.isArray(embeddingData)) {
    throw new Error(`Invalid ${type} embedding data`);
  }
  return embeddingData;
}

/**
 * Recognize face - match against stored profiles
 */
async function recognizeFace(userId, faceDescriptor) {
  try {
    if (!faceDescriptor || !Array.isArray(faceDescriptor)) {
      return {
        status: 'error',
        person_id: null,
        confidence: 0,
        message: 'Invalid face descriptor',
      };
    }

    // Get all face profiles for this user
    const profiles = await PersonProfile.find({ userId });

    let bestMatch = null;
    let bestScore = 0;

    // Compare against all stored faces
    for (const profile of profiles) {
      if (profile.faceDescriptor) {
        const similarity = calculateDescriptorSimilarity(faceDescriptor, profile.faceDescriptor);

        if (similarity > bestScore) {
          bestScore = similarity;
          bestMatch = profile;
        }
      }
    }

    // Check if match is good enough
    const isMatch = bestScore >= FACE_THRESHOLD;

    if (isMatch) {
      // Update recognition history
      bestMatch.recognitionHistory.push({
        timestamp: new Date(),
        faceScore: bestScore,
        voiceScore: 0,
        overallConfidence: bestScore,
        source: 'face',
      });

      // Update face confidence tracking
      bestMatch.faceConfidence = bestScore;
      bestMatch.lastFaceCapture = new Date();
      await bestMatch.save();

      return {
        status: 'matched',
        person_id: bestMatch._id.toString(),
        name: bestMatch.name,
        relationship: bestMatch.relationship,
        confidence: bestScore,
        message: `Recognized ${bestMatch.name} (${bestMatch.relationship})`,
      };
    }

    return {
      status: 'no_match',
      person_id: null,
      confidence: bestScore,
      message: `No face match found (best score: ${bestScore.toFixed(2)})`,
    };
  } catch (error) {
    console.error('Face recognition error:', error);
    throw error;
  }
}

/**
 * Recognize voice - match against stored profiles
 */
async function recognizeVoice(userId, voiceDescriptor, voiceCharacteristics) {
  try {
    if (!voiceDescriptor || !Array.isArray(voiceDescriptor)) {
      return {
        status: 'error',
        person_id: null,
        confidence: 0,
        message: 'Invalid voice descriptor',
      };
    }

    // Get all voice profiles for this user
    const profiles = await PersonProfile.find({ userId });

    let bestMatch = null;
    let bestScore = 0;

    // Compare against all stored voices
    for (const profile of profiles) {
      if (profile.voiceDescriptor) {
        let similarity = calculateDescriptorSimilarity(voiceDescriptor, profile.voiceDescriptor);

        // Boost score if characteristics match
        if (voiceCharacteristics && profile.voiceCharacteristics) {
          const charScore = compareVoiceCharacteristics(voiceCharacteristics, profile.voiceCharacteristics);
          similarity = similarity * 0.6 + charScore * 0.4; // Weighted combination
        }

        if (similarity > bestScore) {
          bestScore = similarity;
          bestMatch = profile;
        }
      }
    }

    // Check if match is good enough
    const isMatch = bestScore >= VOICE_THRESHOLD;

    if (isMatch) {
      // Update recognition history
      bestMatch.recognitionHistory.push({
        timestamp: new Date(),
        faceScore: 0,
        voiceScore: bestScore,
        overallConfidence: bestScore,
        source: 'voice',
      });

      // Update voice confidence tracking
      bestMatch.voiceConfidence = bestScore;
      bestMatch.lastVoiceCapture = new Date();
      await bestMatch.save();

      return {
        status: 'matched',
        person_id: bestMatch._id.toString(),
        name: bestMatch.name,
        relationship: bestMatch.relationship,
        confidence: bestScore,
        message: `Recognized ${bestMatch.name} by voice (${bestMatch.relationship})`,
      };
    }

    return {
      status: 'no_match',
      person_id: null,
      confidence: bestScore,
      message: `No voice match found (best score: ${bestScore.toFixed(2)})`,
    };
  } catch (error) {
    console.error('Voice recognition error:', error);
    throw error;
  }
}

/**
 * Process interaction with both face and voice
 */
async function processInteraction(userId, faceEmbedding, voiceEmbedding, voiceCharacteristics) {
  try {
    const profiles = await PersonProfile.find({ userId });

    let bestFaceMatch = null;
    let bestVoiceMatch = null;
    let bestFaceScore = 0;
    let bestVoiceScore = 0;

    // Score each profile
    for (const profile of profiles) {
      // Face score
      if (faceEmbedding && profile.faceDescriptor) {
        const faceScore = calculateDescriptorSimilarity(faceEmbedding, profile.faceDescriptor);
        if (faceScore > bestFaceScore) {
          bestFaceScore = faceScore;
          bestFaceMatch = profile;
        }
      }

      // Voice score
      if (voiceEmbedding && profile.voiceDescriptor) {
        let voiceScore = calculateDescriptorSimilarity(voiceEmbedding, profile.voiceDescriptor);

        if (voiceCharacteristics && profile.voiceCharacteristics) {
          const charScore = compareVoiceCharacteristics(voiceCharacteristics, profile.voiceCharacteristics);
          voiceScore = voiceScore * 0.6 + charScore * 0.4;
        }

        if (voiceScore > bestVoiceScore) {
          bestVoiceScore = voiceScore;
          bestVoiceMatch = profile;
        }
      }
    }

    // Determine best match
    let matchedProfile = null;
    let overallConfidence = 0;
    const source = [];

    // If both modalities matched the same person
    if (bestFaceMatch && bestVoiceMatch && bestFaceMatch._id.equals(bestVoiceMatch._id)) {
      matchedProfile = bestFaceMatch;
      overallConfidence = (bestFaceScore + bestVoiceScore) / 2;
      source.push('face', 'voice');
    }
    // If both modalities available but different people - take best score
    else if (bestFaceScore > FACE_THRESHOLD || bestVoiceScore > VOICE_THRESHOLD) {
      if (bestFaceScore >= bestVoiceScore) {
        matchedProfile = bestFaceMatch;
        overallConfidence = bestFaceScore;
        source.push('face');
      } else {
        matchedProfile = bestVoiceMatch;
        overallConfidence = bestVoiceScore;
        source.push('voice');
      }
    }

    if (matchedProfile) {
      // Update metrics
      matchedProfile.meetingsCount += 1;
      matchedProfile.lastMeeting = new Date();
      matchedProfile.recognitionHistory.push({
        timestamp: new Date(),
        faceScore: bestFaceScore,
        voiceScore: bestVoiceScore,
        overallConfidence: overallConfidence,
        source: source.join('+'),
      });

      // Keep only last 100 recognition records
      if (matchedProfile.recognitionHistory.length > 100) {
        matchedProfile.recognitionHistory = matchedProfile.recognitionHistory.slice(-100);
      }

      // Update confidence if higher
      if (bestFaceScore > 0) {
        matchedProfile.faceConfidence = Math.max(matchedProfile.faceConfidence, bestFaceScore);
      }
      if (bestVoiceScore > 0) {
        matchedProfile.voiceConfidence = Math.max(matchedProfile.voiceConfidence, bestVoiceScore);
      }

      await matchedProfile.save();

      return {
        person_id: matchedProfile._id.toString(),
        name: matchedProfile.name,
        relationship: matchedProfile.relationship,
        meetings_count: matchedProfile.meetingsCount,
        voice_score: bestVoiceScore,
        face_score: bestFaceScore,
        relationship_score: getRelationshipScore(matchedProfile.relationship),
        overall_confidence: overallConfidence,
        message: `Recognized ${matchedProfile.name}! Nice to see you again! (Meetings: ${matchedProfile.meetingsCount})`,
        known: true,
        recognition_source: source.join(' + '),
      };
    }

    // No match found
    return {
      person_id: null,
      name: null,
      relationship: null,
      meetings_count: 0,
      voice_score: bestVoiceScore,
      face_score: bestFaceScore,
      relationship_score: 0,
      overall_confidence: Math.max(bestFaceScore, bestVoiceScore),
      message: `Hello! I don't recognize you yet. Would you like to introduce yourself?`,
      known: false,
      recognition_source: '',
    };
  } catch (error) {
    console.error('Interaction processing error:', error);
    throw error;
  }
}

/**
 * Learn/register a new person
 */
async function learnPerson(userId, name, relationship, faceDescriptor, voiceDescriptor, voiceCharacteristics) {
  try {
    // Check if person already exists
    let profile = await PersonProfile.findOne({ userId, name });

    if (profile) {
      // Update existing profile
      if (faceDescriptor) {
        profile.faceDescriptor = faceDescriptor;
        profile.faceEmbeddings.push({
          vector: faceDescriptor,
          timestamp: new Date(),
          quality: 0.8,
        });
      }

      if (voiceDescriptor) {
        profile.voiceDescriptor = voiceDescriptor;
        profile.voiceCharacteristics = voiceCharacteristics;
        profile.voiceEmbeddings.push({
          vector: voiceDescriptor,
          timestamp: new Date(),
          quality: 0.8,
        });
      }

      profile.relationship = relationship;
      profile.isLearned = true;
      profile.learningLevel = Math.min(100, profile.learningLevel + 20);
    } else {
      // Create new profile
      profile = new PersonProfile({
        userId,
        name,
        relationship,
        faceDescriptor: faceDescriptor || null,
        voiceDescriptor: voiceDescriptor || null,
        voiceCharacteristics: voiceCharacteristics || null,
        isLearned: true,
        learningLevel: 30,
      });

      if (faceDescriptor) {
        profile.faceEmbeddings.push({
          vector: faceDescriptor,
          timestamp: new Date(),
          quality: 0.8,
        });
      }

      if (voiceDescriptor) {
        profile.voiceEmbeddings.push({
          vector: voiceDescriptor,
          timestamp: new Date(),
          quality: 0.8,
        });
      }
    }

    await profile.save();

    return {
      success: true,
      person_id: profile._id.toString(),
      name: profile.name,
      relationship: profile.relationship,
      learned_modalities: (faceDescriptor ? ['face'] : []).concat(voiceDescriptor ? ['voice'] : []),
      message: `Learned ${name} (${relationship})`,
    };
  } catch (error) {
    console.error('Learn person error:', error);
    throw error;
  }
}

/**
 * Calculate similarity between two descriptors using cosine similarity
 */
function calculateDescriptorSimilarity(descriptor1, descriptor2) {
  if (!Array.isArray(descriptor1) || !Array.isArray(descriptor2)) {
    return 0;
  }

  if (descriptor1.length !== descriptor2.length) {
    return 0;
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < descriptor1.length; i++) {
    dotProduct += descriptor1[i] * descriptor2[i];
    norm1 += descriptor1[i] * descriptor1[i];
    norm2 += descriptor2[i] * descriptor2[i];
  }

  norm1 = Math.sqrt(norm1);
  norm2 = Math.sqrt(norm2);

  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }

  return dotProduct / (norm1 * norm2);
}

/**
 * Compare voice characteristics (pitch, energy, zcr)
 */
function compareVoiceCharacteristics(char1, char2) {
  if (!char1 || !char2) return 0.5;

  const pitchDiff = Math.abs(char1.pitch - char2.pitch) / 500;
  const energyDiff = Math.abs(char1.energy - char2.energy) / 2;
  const zcrDiff = Math.abs(char1.zcr - char2.zcr);

  let score = 1 - (pitchDiff + energyDiff + zcrDiff) / 3;
  score = Math.max(0, Math.min(1, score));

  return score;
}

/**
 * Get score based on relationship
 */
function getRelationshipScore(relationship) {
  const scores = {
    family: 0.95,
    friend: 0.85,
    colleague: 0.75,
    guest: 0.3,
    unknown: 0,
  };

  return scores[relationship] || 0;
}

/**
 * Get all known people for user
 */
async function getPeopleForUser(userId) {
  try {
    const people = await PersonProfile.find({ userId, isLearned: true }).select('-faceDescriptor -voiceDescriptor -recognitionHistory');

    return {
      total: people.length,
      people: people.map((p) => ({
        person_id: p._id.toString(),
        name: p.name,
        relationship: p.relationship,
        meetings_count: p.meetingsCount,
        last_seen: p.lastMeeting,
        confidence: (p.faceConfidence + p.voiceConfidence) / 2,
      })),
    };
  } catch (error) {
    console.error('Get people error:', error);
    throw error;
  }
}

module.exports = {
  recognizeFace,
  recognizeVoice,
  processInteraction,
  learnPerson,
  getPeopleForUser,
  calculateDescriptorSimilarity,
};
