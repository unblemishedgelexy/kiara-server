'use strict';

function validateRetrievalResult(result = {}) {
  if (!result || typeof result !== 'object') {
    throw new Error('Retrieval result must be an object.');
  }
  if (!result.analysis || typeof result.analysis !== 'object') {
    throw new Error('Retrieval result.analysis is required.');
  }
  if (!Array.isArray(result.memories)) {
    throw new Error('Retrieval result.memories must be an array.');
  }
  return result;
}

module.exports = {
  validateRetrievalResult,
};
