const { createHash, randomUUID } = require('node:crypto');
const { env } = require('../config/env');
const { getRedisClient } = require('../services/infrastructure/redisService');

const acquireScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {0, redis.call('PTTL', KEYS[1])}
end
local now = tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[1]) then
  local earliest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  local retryAfter = tonumber(earliest[2]) - now
  return {0, math.max(1000, retryAfter)}
end
local burst = redis.call('INCR', KEYS[3])
if burst == 1 then redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[3])) end
if burst > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[1], '1', 'PX', tonumber(ARGV[4]))
  return {0, tonumber(ARGV[4])}
end
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[5]), ARGV[7])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[5]))
return {1, tonumber(ARGV[5])}
`;

const releaseScript = "return redis.call('ZREM', KEYS[1], ARGV[1])";

function hashPrincipal(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function redisAbuseProtection({
  scope = 'ip',
  bucket = 'api',
  skip = () => false,
  getClient = getRedisClient,
  maxInFlightPerIp = env.abuseMaxInFlightPerIp,
  maxInFlightPerAccount = env.abuseMaxInFlightPerAccount,
  burstMax = env.abuseBurstMax,
  burstWindowSeconds = env.abuseBurstWindowSeconds,
  blockSeconds = env.abuseBlockSeconds,
  leaseSeconds = env.abuseLeaseSeconds,
  additionalIpBuckets = [],
} = {}) {
  return async function protectRequest(req, res, next) {
    if (skip(req)) return next();

    const principals = [];
    if (scope === 'ip' || scope === 'account-ip') {
      const ip = req.ip || req.socket?.remoteAddress;
      if (!ip) {
        return res.status(503).json({
          success: false,
          message: 'Request admission is temporarily unavailable.',
          code: 'ABUSE_PROTECTION_UNAVAILABLE',
        });
      }
      principals.push({ type: 'ip', value: ip, max: maxInFlightPerIp });
    }
    if (scope === 'account' || scope === 'account-ip') {
      if (!req.userId) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }
      principals.push({
        type: 'account',
        value: req.userId,
        max: maxInFlightPerAccount,
      });
    }

    const permitId = randomUUID();
    const acquired = [];
    const checks = [];
    let redisClient;
    const release = async () => {
      if (!acquired.length || !redisClient) return;
      const permits = acquired.splice(0);
      const results = await Promise.allSettled(permits.map(({ activeKey }) =>
        redisClient.eval(releaseScript, { keys: [activeKey], arguments: [permitId] })
      ));
      if (results.some((result) => result.status === 'rejected')) {
        console.error('[ABUSE_PERMIT_RELEASE_FAILED]', 'redis');
      }
    };
    let releaseStarted = false;
    const releaseOnce = () => {
      if (releaseStarted) return;
      releaseStarted = true;
      void release();
    };

    try {
      redisClient = await getClient();
      for (const principal of principals) {
        const principalHash = hashPrincipal(principal.value);
        const buckets = principal.type === 'ip'
          ? [...new Set([bucket, ...additionalIpBuckets])]
          : [bucket];
        for (const principalBucket of buckets) {
          const prefix = `kiara:abuse:${principalBucket}:${principal.type}:${principalHash}`;
          checks.push({
            activeKey: `${prefix}:active`,
            promise: redisClient.eval(acquireScript, {
              keys: [`${prefix}:blocked`, `${prefix}:active`, `${prefix}:burst`],
              arguments: [
                String(principal.max),
                String(burstMax),
                String(burstWindowSeconds * 1000),
                String(blockSeconds * 1000),
                String(leaseSeconds * 1000),
                String(Date.now()),
                permitId,
              ],
            }),
          });
        }
      }

      const outcomes = await Promise.allSettled(checks.map(({ promise }) => promise));
      const denied = [];
      const failed = [];
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'rejected') {
          failed.push(outcome.reason);
        } else if (Number(outcome.value?.[0]) === 1) {
          acquired.push({ activeKey: checks[index].activeKey });
        } else {
          denied.push(outcome.value);
        }
      });

      if (failed.length) throw failed[0];
      if (denied.length) {
        await release();
        const retryAfter = Math.max(1, Math.ceil(Number(denied[0]?.[1] || 1000) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
          success: false,
          message: `Too many requests at once. Please wait ${retryAfter} seconds and try again.`,
          code: 'REQUEST_TEMPORARILY_BLOCKED',
          retryAfterSeconds: retryAfter,
        });
      }

      res.once('finish', releaseOnce);
      res.once('close', releaseOnce);
      req.once('aborted', releaseOnce);
      return next();
    } catch (error) {
      await release();
      console.error('[ABUSE_PROTECTION_UNAVAILABLE]', error?.name || error?.code || 'redis');
      return res.status(503).json({
        success: false,
        message: 'Request admission is temporarily unavailable.',
        code: 'ABUSE_PROTECTION_UNAVAILABLE',
      });
    }
  };
}

module.exports = redisAbuseProtection;
