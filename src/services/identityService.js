const crypto = require('crypto');

const IDENTITY_EMBEDDING_DIM = 512;

function createRandomEmbedding(dim = IDENTITY_EMBEDDING_DIM) {
  return Array.from({ length: dim }, () => Number((crypto.randomInt(0, 10001) / 10000).toFixed(6)));
}

function getEmbeddingResponse(file, type) {
  return {
    status: 'ok',
    embedding: createRandomEmbedding(),
    metadata: {
      filename: file.originalname || file.filename || 'unknown',
      ...(type === 'face'
        ? { faces_detected: 1, embedding_dim: IDENTITY_EMBEDDING_DIM }
        : { sample_rate: 48000, duration_seconds: 4.0, embedding_dim: IDENTITY_EMBEDDING_DIM }),
    },
  };
}

async function recognizeFace(file) {
  if (!file) {
    throw new Error('No face file uploaded');
  }

  return getEmbeddingResponse(file, 'face');
}

async function recognizeVoice(file) {
  if (!file) {
    throw new Error('No voice file uploaded');
  }

  return getEmbeddingResponse(file, 'voice');
}

async function processInteraction({ face_embedding, voice_embedding }) {
  const hasFace = Array.isArray(face_embedding) && face_embedding.length > 0;
  const hasVoice = Array.isArray(voice_embedding) && voice_embedding.length > 0;

  const overallConfidence = hasFace || hasVoice ? 0.15 : 0.0;

  return {
    person_id: null,
    name: null,
    relationship: null,
    meetings_count: 0,
    voice_score: hasVoice ? 0.15 : 0.0,
    face_score: hasFace ? 0.15 : 0.0,
    relationship_score: 0.0,
    overall_confidence: overallConfidence,
    message: 'Identity backend is available, but no trained model is configured yet.',
    known: false,
  };
}

async function learnPerson({ person_id, name, relationship, voice_embedding, face_embedding }) {
  return {
    success: true,
    person_id: person_id || `person-${Date.now()}`,
    name: name || null,
    relationship: relationship || null,
    voice_embedding: Array.isArray(voice_embedding) ? voice_embedding : null,
    face_embedding: Array.isArray(face_embedding) ? face_embedding : null,
    message: 'Person learning endpoint received the data successfully.',
  };
}

async function getPeople(limit = 100) {
  return {
    total: 0,
    people: [],
  };
}

async function getStats() {
  return {
    total_people: 0,
    voice_embedding_dim: IDENTITY_EMBEDDING_DIM,
    face_embedding_dim: IDENTITY_EMBEDDING_DIM,
  };
}

module.exports = {
  recognizeFace,
  recognizeVoice,
  processInteraction,
  learnPerson,
  getPeople,
  getStats,
};
