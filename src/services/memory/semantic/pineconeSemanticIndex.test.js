'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PineconeSemanticIndex } = require('./pineconeSemanticIndex');
const { namespaceForUser } = require('./semanticIndexMapper');

test('deletes only the canonical namespace derived from the requested user', async () => {
  const deletedNamespaces = [];
  const semanticIndex = new PineconeSemanticIndex({
    getIndex: async () => ({
      deleteNamespace: async (namespace) => deletedNamespaces.push(namespace),
    }),
  });
  const userId = 'user-to-delete';

  const result = await semanticIndex.deleteUserNamespace(userId);

  assert.deepEqual(result, { deleted: true, mode: 'namespace' });
  assert.deepEqual(deletedNamespaces, [namespaceForUser(userId)]);
});

test('rejects a missing user before deleting any namespace', async () => {
  let deleteCalled = false;
  const semanticIndex = new PineconeSemanticIndex({
    getIndex: async () => ({
      deleteNamespace: async () => { deleteCalled = true; },
    }),
  });

  await assert.rejects(semanticIndex.deleteUserNamespace(' '), {
    name: 'SemanticIndexError',
    code: 'SEMANTIC_INFRASTRUCTURE_FAILURE',
  });
  assert.equal(deleteCalled, false);
});

test('falls back to ID-batched deletion within only the requested user namespace', async () => {
  const namespace = namespaceForUser('user-to-delete');
  const deletedIds = [];
  const semanticIndex = new PineconeSemanticIndex({
    getIndex: async () => ({
      deleteNamespace: async () => { throw new Error('namespace deletion unavailable'); },
      listPaginated: async (options) => {
        assert.equal(options.namespace, namespace);
        return { vectors: [{ id: 'memory-1' }, { id: 'memory-2' }] };
      },
      deleteMany: async (options) => {
        assert.equal(options.namespace, namespace);
        deletedIds.push(...options.ids);
      },
    }),
  });

  const result = await semanticIndex.deleteUserNamespace('user-to-delete');

  assert.deepEqual(result, { deleted: true, mode: 'listed_ids', count: 2 });
  assert.deepEqual(deletedIds, ['memory-1', 'memory-2']);
});

test('does not fall back to deleting vectors if listing the user namespace fails', async () => {
  let deleteManyCalled = false;
  const semanticIndex = new PineconeSemanticIndex({
    getIndex: async () => ({
      deleteNamespace: async () => { throw new Error('namespace deletion unavailable'); },
      listPaginated: async () => { throw new Error('listing unavailable'); },
      deleteMany: async () => { deleteManyCalled = true; },
    }),
  });

  await assert.rejects(semanticIndex.deleteUserNamespace('user-to-delete'), {
    name: 'SemanticIndexError',
    code: 'SEMANTIC_INFRASTRUCTURE_FAILURE',
  });
  assert.equal(deleteManyCalled, false);
});
