// Migration script: copy category-specific memory collections into canonical LongTermMemory
const mongoose = require('mongoose');
const { env } = require('../src/config/env');
const IdentityMemory = require('../src/models/IdentityMemory');
const PreferenceMemory = require('../src/models/PreferenceMemory');
const RelationshipMemory = require('../src/models/RelationshipMemory');
const ProjectMemory = require('../src/models/ProjectMemory');
const GoalMemory = require('../src/models/GoalMemory');
const EpisodicMemory = require('../src/models/EpisodicMemory');
const LongTermMemory = require('../src/models/LongTermMemory');

async function migrateCollection(Model) {
  const docs = await Model.find({}).lean();
  let migrated = 0;
  for (const d of docs) {
    if (!d.userId || !d.fingerprint || !d.encryptedMemory) continue;
    try {
      await LongTermMemory.findOneAndUpdate(
        { userId: d.userId, fingerprint: d.fingerprint },
        {
          $set: {
            category: d.category || 'other',
            encryptedMemory: d.encryptedMemory,
            tags: d.tags || [],
            importanceScore: d.importanceScore || 0.5,
            accessCount: d.accessCount || 0,
            lastAccessed: d.lastAccessed || d.createdAt,
            confidence: d.confidence || 0.5,
          },
          $setOnInsert: { userId: d.userId, fingerprint: d.fingerprint },
        },
        { upsert: true }
      );
      migrated += 1;
    } catch (e) {
      console.warn('migrate error for doc', d._id, e.message || e);
    }
  }
  return migrated;
}

async function run() {
  try {
    await mongoose.connect(env.mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB, starting migration...');
    let total = 0;
    total += await migrateCollection(IdentityMemory);
    total += await migrateCollection(PreferenceMemory);
    total += await migrateCollection(RelationshipMemory);
    total += await migrateCollection(ProjectMemory);
    total += await migrateCollection(GoalMemory);
    total += await migrateCollection(EpisodicMemory);
    console.log('Migration complete. Total migrated:', total);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(2);
  }
}

if (require.main === module) run();
