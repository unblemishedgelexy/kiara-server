'use strict';

const { PineconeSemanticIndex } = require('./pineconeSemanticIndex');

module.exports = {
  semanticIndex: new PineconeSemanticIndex(),
  PineconeSemanticIndex,
};
