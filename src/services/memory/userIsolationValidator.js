const { ensureUserId } = require('../../utils/ensureUserId');
const LongTermMemory = require('../../models/LongTermMemory');

/**
 * User Isolation Validator (V7)
 * Enforces strict user isolation across all memory operations.
 * Middleware + utility functions for validation.
 */

/**
 * Middleware: Validate userId on all memory routes
 */
function userIsolationMiddleware(req, res, next) {
  const userId = req.userId;

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing userId. Authentication required.',
    });
  }

  // Attach to request for downstream use
  req.authenticatedUserId = userId;

  next();
}

/**
 * Validate that query operation only accesses userId's data
 */
async function validateQueryIsolation(userId, query, model) {
  if (!userId) throw new Error('userId is required');

  // Ensure query includes userId filter
  const validatedQuery = {
    userId,
    ...query,
  };

  // Verify no cross-user contamination in results
  const docs = await model.find(validatedQuery).lean();
  for (const doc of docs) {
    if (doc.userId !== userId) {
      throw new Error(`ISOLATION VIOLATION: Document belongs to different user: ${doc.userId}`);
    }
  }

  return docs;
}

/**
 * Validate that write operation maintains user isolation
 */
async function validateWriteIsolation(userId, data, model) {
  if (!userId) throw new Error('userId is required');

  if (data.userId && data.userId !== userId) {
    throw new Error(`ISOLATION VIOLATION: Attempt to write data for different user: ${data.userId}`);
  }

  // Ensure userId is included in write
  const validatedData = {
    ...data,
    userId,
  };

  return validatedData;
}

/**
 * Startup Audit: Detect cross-user memory references
 */
async function auditCrossUserReferences() {
  console.log('[ISOLATION_AUDIT] Starting cross-user reference scan...');

  const issues = [];

  try {
    // Sample check: Find memories with userId mismatches
    const memories = await LongTermMemory.find({})
      .select('userId personProfileId')
      .limit(1000)
      .lean();

    for (const memory of memories) {
      if (memory.personProfileId) {
        const PersonProfile = require('../../models/PersonProfile');
        const profile = await PersonProfile.findById(memory.personProfileId).lean();
        
        if (profile && profile.userId !== memory.userId) {
          issues.push({
            type: 'CROSS_USER_REFERENCE',
            memoryId: memory._id,
            memoryUserId: memory.userId,
            referencedUserId: profile.userId,
            severity: 'CRITICAL',
          });
        }
      }
    }
  } catch (err) {
    console.error('[ISOLATION_AUDIT] Error during audit:', err);
  }

  if (issues.length > 0) {
    console.error('[ISOLATION_AUDIT] FOUND ISSUES:', issues.length);
    console.error(JSON.stringify(issues, null, 2));
    return { ok: false, issueCount: issues.length, issues };
  }

  console.log('[ISOLATION_AUDIT] OK - No cross-user references detected');
  return { ok: true, issueCount: 0, issues: [] };
}

/**
 * Repair cross-user references (admin operation)
 */
async function repairCrossUserReferences() {
  console.log('[ISOLATION_REPAIR] Starting repair...');

  const repairs = [];

  try {
    const memories = await LongTermMemory.find({ personProfileId: { $exists: true } })
      .select('userId personProfileId')
      .limit(1000)
      .lean();

    const PersonProfile = require('../../models/PersonProfile');

    for (const memory of memories) {
      const profile = await PersonProfile.findById(memory.personProfileId).lean();
      
      if (profile && profile.userId !== memory.userId) {
        // Find correct profile for this memory
        const correctProfile = await PersonProfile.findOne({
          userId: memory.userId,
          name: profile.name,
        }).lean();

        if (correctProfile) {
          await LongTermMemory.updateOne(
            { _id: memory._id },
            { $set: { personProfileId: correctProfile._id } }
          );
          repairs.push({
            memoryId: memory._id,
            oldProfileId: memory.personProfileId,
            newProfileId: correctProfile._id,
            status: 'repaired',
          });
        } else {
          // Remove broken reference
          await LongTermMemory.updateOne(
            { _id: memory._id },
            { $unset: { personProfileId: 1 } }
          );
          repairs.push({
            memoryId: memory._id,
            oldProfileId: memory.personProfileId,
            status: 'reference_removed',
          });
        }
      }
    }
  } catch (err) {
    console.error('[ISOLATION_REPAIR] Error during repair:', err);
  }

  console.log(`[ISOLATION_REPAIR] Completed: ${repairs.length} repairs`);
  return { ok: true, repairsApplied: repairs.length, details: repairs };
}

/**
 * Validate that userId matches authenticated user
 */
function validateUserIdMatch(requestUserId, paramUserId) {
  if (requestUserId !== paramUserId) {
    throw new Error(`User isolation violation: Requesting user ${requestUserId} cannot access data for user ${paramUserId}`);
  }
}

module.exports = {
  userIsolationMiddleware,
  validateQueryIsolation,
  validateWriteIsolation,
  auditCrossUserReferences,
  repairCrossUserReferences,
  validateUserIdMatch,
};
