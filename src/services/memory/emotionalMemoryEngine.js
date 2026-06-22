const { ensureUserId } = require('../../utils/ensureUserId');

/**
 * Emotional Memory Engine (V7)
 * Tracks emotional context separately from factual memories.
 */

const VALID_EMOTIONS = [
  'frustrated',
  'excited',
  'motivated',
  'afraid',
  'confident',
  'happy',
  'sad',
  'angry',
  'confused',
  'calm',
  'neutral',
];

const redis = require('redis');
let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    const redisService = require('../infrastructure/redisService');
    redisClient = await redisService.getRedisClient();
  }
  return redisClient;
}

async function recordEmotion(userId, emotion, context = {}, intensity = 0.5) {
  ensureUserId(userId);

  if (!VALID_EMOTIONS.includes(emotion)) {
    throw new Error(`Invalid emotion: ${emotion}. Valid: ${VALID_EMOTIONS.join(', ')}`);
  }

  intensity = Math.max(0, Math.min(1, intensity)); // Clamp 0-1

  const client = await getRedisClient();
  const key = `emotions:${userId}`;
  
  const emotionRecord = {
    emotion,
    intensity,
    context: JSON.stringify(context),
    timestamp: new Date().toISOString(),
  };

  // Store in Redis with 24h TTL
  await client.lpush(key, JSON.stringify(emotionRecord));
  await client.expire(key, 24 * 60 * 60);

  return emotionRecord;
}

async function getEmotionalState(userId) {
  ensureUserId(userId);

  const client = await getRedisClient();
  const key = `emotions:${userId}`;

  const records = await client.lrange(key, 0, 99); // Last 100 records
  
  if (!records || records.length === 0) {
    return {
      currentEmotion: 'neutral',
      emotionHistory: [],
      dominantEmotions: {},
      emotionalTrend: 'stable',
    };
  }

  const emotionHistory = records.map((r) => JSON.parse(r));
  
  // Calculate emotion frequency
  const dominantEmotions = {};
  for (const record of emotionHistory) {
    dominantEmotions[record.emotion] = (dominantEmotions[record.emotion] || 0) + 1;
  }

  // Get most recent emotion
  const currentEmotion = emotionHistory[0]?.emotion || 'neutral';

  // Determine trend
  const recent = emotionHistory.slice(0, 10);
  const older = emotionHistory.slice(10, 20);
  
  let emotionalTrend = 'stable';
  if (recent.length > 0 && older.length > 0) {
    const recentAvgIntensity = recent.reduce((sum, r) => sum + r.intensity, 0) / recent.length;
    const olderAvgIntensity = older.reduce((sum, r) => sum + r.intensity, 0) / older.length;
    
    if (recentAvgIntensity > olderAvgIntensity + 0.2) {
      emotionalTrend = 'improving';
    } else if (recentAvgIntensity < olderAvgIntensity - 0.2) {
      emotionalTrend = 'declining';
    }
  }

  return {
    currentEmotion,
    emotionHistory: emotionHistory.slice(0, 10), // Last 10
    dominantEmotions,
    emotionalTrend,
  };
}

async function getEmotionalMemories(userId, emotion = null, limit = 10) {
  ensureUserId(userId);

  const client = await getRedisClient();
  const key = `emotions:${userId}`;

  const records = await client.lrange(key, 0, limit * 2);
  
  if (!records || records.length === 0) {
    return [];
  }

  let parsed = records.map((r) => {
    try {
      return JSON.parse(r);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);

  if (emotion) {
    parsed = parsed.filter((r) => r.emotion === emotion);
  }

  return parsed.slice(0, limit);
}

async function associateEmotionWithMemory(userId, memoryId, emotion, intensity = 0.5) {
  ensureUserId(userId);

  if (!VALID_EMOTIONS.includes(emotion)) {
    throw new Error(`Invalid emotion: ${emotion}`);
  }

  intensity = Math.max(0, Math.min(1, intensity));

  const client = await getRedisClient();
  const key = `memory:emotions:${userId}:${memoryId}`;

  const association = {
    emotion,
    intensity,
    associatedAt: new Date().toISOString(),
  };

  await client.set(key, JSON.stringify(association), { EX: 30 * 24 * 60 * 60 }); // 30 days

  return association;
}

async function getEmotionForMemory(userId, memoryId) {
  ensureUserId(userId);

  const client = await getRedisClient();
  const key = `memory:emotions:${userId}:${memoryId}`;

  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

async function summarizeEmotionalContext(userId) {
  ensureUserId(userId);

  const state = await getEmotionalState(userId);
  const recent = await getEmotionalMemories(userId, null, 20);

  // Determine emotional summary
  let summary = '';
  const current = state.currentEmotion;

  if (current === 'frustrated' || current === 'angry') {
    summary = 'seems stressed or frustrated';
  } else if (current === 'excited' || current === 'happy') {
    summary = 'is in a positive mood';
  } else if (current === 'motivated' || current === 'confident') {
    summary = 'feels motivated and confident';
  } else if (current === 'afraid' || current === 'confused') {
    summary = 'seems uncertain or concerned';
  } else {
    summary = 'is feeling neutral';
  }

  return {
    summary,
    currentEmotion: current,
    trend: state.emotionalTrend,
    recentEmotions: recent.map((r) => r.emotion),
    context: state,
  };
}

module.exports = {
  recordEmotion,
  getEmotionalState,
  getEmotionalMemories,
  associateEmotionWithMemory,
  getEmotionForMemory,
  summarizeEmotionalContext,
  VALID_EMOTIONS,
};
