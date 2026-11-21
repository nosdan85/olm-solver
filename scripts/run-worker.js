'use strict';

require('dotenv').config();

const { setTimeout: sleep } = require('node:timers/promises');
const shared = require('../src/deployment-store');
const runner = require('../src/runner');
const { refreshSharedProxy } = require('../src/proxy');

let stopping = false;
const active = new Set();
function stop() {
  stopping = true;
  for (const run of active) runner.stopRun(run.id);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function execute(job) {
  let run;
  try {
    await refreshSharedProxy();
    const session = await shared.sessions.get(job.session_id);
    if (!session) throw new Error('Phiên OLM đã hết hạn.');
    const { homeworks, config, license } = job.payload;
    if (process.env.ENFORCE_LICENSE !== 'false' &&
        !(await shared.licenses.verify({ ...license, olmUsername: session.username })).valid) {
      throw new Error('License hết hạn hoặc đã bị thu hồi trong lúc chờ.');
    }
    if (stopping || await shared.jobs.heartbeat(job.id, { id: job.id, status: 'running', phase: 'starting', homeworks: [], logs: [] })) {
      await shared.jobs.finish(job.id, { id: job.id, status: 'stopped', phase: 'stopped', homeworks: [], logs: [] });
      return;
    }
    const perRun = Math.min(4, Math.max(1, Number(process.env.WORKER_HOMEWORK_CONCURRENCY) || 2));
    run = await runner.startRun({
      session, homeworks, config: { ...config, concurrency: Math.min(config.concurrency, perRun) }, sessionId: session.id, runId: job.id,
    });
    active.add(run);
    while (!run.finishedAt) {
      if (stopping || await shared.jobs.heartbeat(job.id, shared.runSnapshot(run))) runner.stopRun(run.id);
      await sleep(2000);
    }
    await shared.jobs.finish(job.id, shared.runSnapshot(run));
  } catch (error) {
    if (run) runner.stopRun(run.id);
    while (run && !run.finishedAt) await sleep(200);
    const snapshot = run ? shared.runSnapshot(run) : { id: job.id, homeworks: [], logs: [] };
    // A failed status write must not turn a confirmed submission into a failed job.
    await shared.jobs.finish(job.id, ['done', 'partial'].includes(snapshot.status) ? snapshot : {
      ...snapshot,
      status: 'error', phase: 'error', error: error.message,
    }).catch(() => {});
  } finally {
    if (run) active.delete(run);
  }
}

async function worker() {
  while (!stopping) {
    try {
      const job = await shared.jobs.claim();
      if (job) await execute(job);
      else await sleep(1000);
    } catch (error) {
      console.error('[worker]', error.code || error.message);
      await sleep(3000);
    }
  }
}

async function main() {
  if (!shared.configured) throw new Error('DATABASE_URL is required for the worker.');
  await shared.init();
  await shared.jobs.sweep();
  const interval = setInterval(() => shared.jobs.sweep().catch((error) => console.error('[worker sweep]', error.code)), 30000);
  const slots = Math.min(4, Math.max(1, Math.trunc(Number(process.env.WORKER_RUN_SLOTS) || 1)));
  try {
    await Promise.all(Array.from({ length: slots }, () => worker()));
  } finally {
    clearInterval(interval);
    await shared.close();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

