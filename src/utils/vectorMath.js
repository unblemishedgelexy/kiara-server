/**
 * Vector Math Utilities
 * Used for similarity calculations in identity recognition
 */

/**
 * Calculate cosine similarity between two vectors (0-1)
 */
function cosineSimilarity(vec1, vec2) {
  if (!Array.isArray(vec1) || !Array.isArray(vec2)) {
    return 0;
  }

  if (vec1.length !== vec2.length) {
    return 0;
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }

  norm1 = Math.sqrt(norm1);
  norm2 = Math.sqrt(norm2);

  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }

  return dotProduct / (norm1 * norm2);
}

/**
 * Calculate Euclidean distance between two vectors
 */
function euclideanDistance(vec1, vec2) {
  if (!Array.isArray(vec1) || !Array.isArray(vec2)) {
    return Infinity;
  }

  if (vec1.length !== vec2.length) {
    return Infinity;
  }

  let sumSquaredDiff = 0;
  for (let i = 0; i < vec1.length; i++) {
    const diff = vec1[i] - vec2[i];
    sumSquaredDiff += diff * diff;
  }

  return Math.sqrt(sumSquaredDiff);
}

/**
 * Normalize vector to unit length
 */
function normalizeVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) {
    return vec;
  }

  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }

  norm = Math.sqrt(norm);

  if (norm === 0) {
    return vec;
  }

  return vec.map((v) => v / norm);
}

module.exports = {
  cosineSimilarity,
  euclideanDistance,
  normalizeVector,
};
