'use strict';

const { SemanticIndexContract, SemanticIndexError } = require('./semanticIndexContract');
const { semanticIndex, PineconeSemanticIndex } = require('./semanticIndex');
const { embedMemory, embedQuery } = require('./semanticEmbedding');
const mapper = require('./semanticIndexMapper');

module.exports = {
  SemanticIndexContract,
  SemanticIndexError,
  semanticIndex,
  PineconeSemanticIndex,
  embedMemory,
  embedQuery,
  ...mapper,
};
