'use strict';

if (require.main === module) require('dotenv').config();

const { setTimeout: sleep } = require('node:timers/promises');
const shared = require('../src/deployment-store');
const runner = require('../src/runner');
const { refreshSharedProxy } = require('../src/proxy');

async function execute(job, state) {
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
    if (state.stopping || await shared.jobs.heartbeat(job.id, { id: job.id, status: 'running', phase: 'starting', homeworks: [], logs: [] })) {
      await shared.jobs.finish(job.id, { id: job.id, status: 'stopped', phase: 'stopped', homeworks: [], logs: [] });
      return;
    }
    const perRun = Math.min(4, Math.max(1, Number(process.env.WORKER_HOMEWORK_CONCURRENCY) || 2));
    run = await runner.startRun({
      session, homeworks, config: { ...config, concurrency: Math.min(config.concurrency, perRun) }, sessionId: session.id, runId: job.id,
    });
    state.active.add(run);
    while (!run.finishedAt) {
      if (state.stopping || await shared.jobs.heartbeat(job.id, shared.runSnapshot(run))) runner.stopRun(run.id);
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
    if (run) state.active.delete(run);
  }
}

async function interruptibleSleep(ms, signal) {
  if (signal.aborted) return;
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
  }
}

async function worker(state) {
  while (!state.stopping) {
    try {
      const job = await shared.jobs.claim();
      if (job) await execute(job, state);
      else await interruptibleSleep(1000, state.abortController.signal);
    } catch (error) {
      console.error('[worker]', error.code || error.message);
      await interruptibleSleep(3000, state.abortController.signal);
    }
  }
}

async function startWorkerLoop({ initStore = false, closeStore = false } = {}) {
  if (!shared.configured) throw new Error('DATABASE_URL is required for the worker.');
  if (initStore) await shared.init();
  await shared.jobs.sweep();

  const state = {
    stopping: false,
    active: new Set(),
    abortController: new AbortController(),
  };

  const stop = () => {
    if (state.stopping) return;
    state.stopping = true;
    state.abortController.abort();
    for (const run of state.active) runner.stopRun(run.id);
  };

  const interval = setInterval(
    () => shared.jobs.sweep().catch((error) => console.error('[worker sweep]', error.code || error.message)),
    30000
  );
  if (interval.unref) interval.unref();

  const slots = Math.min(4, Math.max(1, Math.trunc(Number(process.env.WORKER_RUN_SLOTS) || 1)));
  const done = Promise.all(Array.from({ length: slots }, () => worker(state))).finally(async () => {
    clearInterval(interval);
    if (closeStore) await shared.close();
  });

  return { stop, done };
}

async function main() {
  const handle = await startWorkerLoop({ initStore: true, closeStore: true });
  process.once('SIGINT', handle.stop);
  process.once('SIGTERM', handle.stop);
  await handle.done;
}

module.exports = { startWorkerLoop };

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error.message);
    await Promise.resolve(shared.close()).catch(() => {});
    process.exitCode = 1;
  });
}

