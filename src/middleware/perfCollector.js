const metrics = {
  stages: {},
  longTasks: [],
  gemini: [],
  redis: [],
};

function record(stage, durationMs, meta) {
  if (!metrics.stages[stage]) metrics.stages[stage] = { count: 0, durations: [] };
  const s = metrics.stages[stage];
  s.count += 1;
  s.durations.push(durationMs || 0);
  if (s.durations.length > 2000) s.durations.shift();
}

function recordLongTask(task) {
  metrics.longTasks.push(Object.assign({ ts: Date.now() }, task));
  if (metrics.longTasks.length > 1000) metrics.longTasks.shift();
}

function recordGemini(entry) {
  metrics.gemini.push(Object.assign({ ts: Date.now() }, entry));
  if (metrics.gemini.length > 2000) metrics.gemini.shift();
}

function recordRedis(entry) {
  metrics.redis.push(Object.assign({ ts: Date.now() }, entry));
  if (metrics.redis.length > 2000) metrics.redis.shift();
}

function getSummary() {
  const stages = {};
  for (const k of Object.keys(metrics.stages)) {
    const arr = metrics.stages[k].durations.slice();
    arr.sort((a,b) => a-b);
    const avg = arr.reduce((a,b)=>a+b,0)/Math.max(1,arr.length);
    stages[k] = { count: metrics.stages[k].count, avg, min: arr[0]||0, max: arr[arr.length-1]||0, p95: arr[Math.floor(arr.length*0.95)]||0 };
  }

  return {
    timestamp: Date.now(),
    stages,
    longTasks: metrics.longTasks.slice(-50),
    gemini: metrics.gemini.slice(-50),
    redis: metrics.redis.slice(-50),
  };
}

module.exports = { record, recordLongTask, recordGemini, recordRedis, getSummary };
