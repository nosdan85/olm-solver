'use strict';

const { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const rules = require('./license-store');

const configured = Boolean(process.env.DATABASE_URL);
const MAX_POOL = integer(process.env.DB_POOL_SIZE, 10, 2, 40);
const pool = configured ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: MAX_POOL,
  connectionTimeoutMillis: 2500,
  idleTimeoutMillis: 30000,
  statement_timeout: 6000,
}) : null;
pool?.on('error', (error) => console.error('[postgres]', error.code || error.message));

function integer(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function unavailable(message = 'Máy chủ đang bận. Vui lòng thử lại sau.') {
  return Object.assign(new Error(message), { status: 503 });
}

function checkPool() {
  if (pool.waitingCount >= MAX_POOL * 4) throw unavailable();
}

async function query(sql, values) {
  checkPool();
  return pool.query(sql, values);
}

async function transaction(callback) {
  checkPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function init() {
  if (!pool) return;
  if (Buffer.byteLength(process.env.SESSION_SECRET || '') < 32) {
    throw new Error('DATABASE_URL requires a shared SESSION_SECRET of at least 32 bytes.');
  }
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(839200)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS olm_sessions (
        id text PRIMARY KEY, content text NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS olm_sessions_expires ON olm_sessions (expires_at);
      CREATE TABLE IF NOT EXISTS olm_admin_sessions (
        id text PRIMARY KEY, expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS olm_admin_sessions_expires ON olm_admin_sessions (expires_at);
      CREATE TABLE IF NOT EXISTS olm_settings (key text PRIMARY KEY, content text NOT NULL);
      CREATE TABLE IF NOT EXISTS olm_licenses (
        key text PRIMARY KEY, content jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS olm_jobs (
        id text PRIMARY KEY, session_id text NOT NULL, owner text NOT NULL,
        status text NOT NULL, payload jsonb NOT NULL, snapshot jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        cancel_requested boolean NOT NULL DEFAULT false
      );
      CREATE UNIQUE INDEX IF NOT EXISTS olm_jobs_one_active
        ON olm_jobs (owner) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS olm_jobs_queued ON olm_jobs (created_at) WHERE status = 'queued';
      CREATE INDEX IF NOT EXISTS olm_jobs_active ON olm_jobs (status, updated_at) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS olm_jobs_session ON olm_jobs (session_id, created_at DESC);
    `);
  });
}

function encryptionKey() {
  return createHash('sha256').update(process.env.SESSION_SECRET).digest();
}

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

function open(content) {
  const buffer = Buffer.from(content, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]));
}

const sessions = {
  async create(username, cookieJar, ua) {
    const session = { id: randomBytes(24).toString('hex'), username, cookieJar, ua, createdAt: Date.now() };
    await query("INSERT INTO olm_sessions VALUES ($1, $2, now() + interval '7 days')", [session.id, seal(session)]);
    return session;
  },
  async get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) return null;
    const { rows } = await query('SELECT content FROM olm_sessions WHERE id=$1 AND expires_at>now()', [id]);
    return rows[0] ? open(rows[0].content) : null;
  },
  async updateCookies(id, cookieJar, ua, currentSession) {
    const session = currentSession || await sessions.get(id);
    if (!session) return null;
    const updated = { ...session, cookieJar, ua };
    await query('UPDATE olm_sessions SET content=$2 WHERE id=$1 AND expires_at>now()', [id, seal(updated)]);
    return updated;
  },
  async destroy(id) {
    await query('DELETE FROM olm_sessions WHERE id=$1', [id]);
  },
};

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
const adminSessions = {
  async get(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    const result = await query('SELECT 1 FROM olm_admin_sessions WHERE id=$1 AND expires_at>now()', [hashToken(token)]);
    return result.rowCount === 1;
  },
  async add(token) {
    await query("INSERT INTO olm_admin_sessions VALUES ($1, now() + interval '8 hours')", [hashToken(token)]);
  },
  async delete(token) {
    await query('DELETE FROM olm_admin_sessions WHERE id=$1', [hashToken(token)]);
  },
};

function lookupKey(value) {
  return typeof value === 'string' && value.length <= 200 ? value.trim().toUpperCase() : '';
}

async function licenseRead(name, args, key) {
  const result = key === undefined
    ? await query('SELECT content FROM olm_licenses')
    : key ? await query('SELECT content FROM olm_licenses WHERE key=$1', [key]) : { rows: [] };
  const { value } = rules.withRecords(result.rows.map((row) => row.content), () => rules[name](...args));
  return value;
}

async function licenseWrite(name, args, key) {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(839201)');
    const all = name === 'importAll' || name === 'clearAll';
    if (name === 'createKey') {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { value } = rules.withRecords([], () => rules.createKey(...args));
        const inserted = await client.query('INSERT INTO olm_licenses VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [value.key, value]);
        if (inserted.rowCount) return value;
      }
      throw new Error('Could not allocate a unique license key.');
    }
    const result = all ? await client.query('SELECT content FROM olm_licenses') :
      key ? await client.query('SELECT content FROM olm_licenses WHERE key=$1', [key]) : { rows: [] };
    const { value, records } = rules.withRecords(result.rows.map((row) => row.content), () => rules[name](...args));

    if (all) await client.query('DELETE FROM olm_licenses');
    else if (key && !records.length) await client.query('DELETE FROM olm_licenses WHERE key=$1', [key]);
    if (records.length) {
      await client.query(`
        INSERT INTO olm_licenses (key, content)
        SELECT item->>'key', item FROM jsonb_array_elements($1::jsonb) AS item
        ON CONFLICT (key) DO UPDATE SET content=excluded.content
      `, [JSON.stringify(records)]);
    }
    return value;
  });
}

async function verifyLicense(input) {
  const key = lookupKey(input?.key);
  if (!key) return rules.verify(input);
  const { rows } = await query('SELECT content FROM olm_licenses WHERE key=$1', [key]);
  const existing = rows[0]?.content;
  const { value } = rules.withRecords(existing ? [existing] : [], () => rules.verify(input));
  const now = Date.now();
  const shouldPersist = value.expired || (value.ok && value.valid && now - (existing?.lastChecked || 0) > 60_000);
  if (shouldPersist) {
    return licenseWrite('verify', [input], key);
  }
  return value;
}

const licenses = {
  verify: verifyLicense,
  listAll: () => licenseRead('listAll', []),
  exportAll: () => licenseRead('exportAll', []),
  activate: (input) => licenseWrite('activate', [input], lookupKey(input.key)),
  createKey: (input) => licenseWrite('createKey', [input]),
  extendKey: (key, days) => licenseWrite('extendKey', [key, days], lookupKey(key)),
  resetHwid: (key) => licenseWrite('resetHwid', [key], lookupKey(key)),
  unbindOlm: (key) => licenseWrite('unbindOlm', [key], lookupKey(key)),
  deleteKey: (key) => licenseWrite('deleteKey', [key], lookupKey(key)),
  importAll: (...args) => licenseWrite('importAll', args),
  clearAll: () => licenseWrite('clearAll', []),
};

const settings = {
  async getProxy() {
    const { rows } = await query("SELECT content FROM olm_settings WHERE key='proxy'");
    return rows.length ? open(rows[0].content) : undefined;
  },
  async setProxy(value) {
    await query("INSERT INTO olm_settings VALUES ('proxy',$1) ON CONFLICT (key) DO UPDATE SET content=excluded.content",
      [seal(value)]);
  },
};

function runSnapshot(run) {
  return {
    id: run.id, status: run.status, phase: run.phase, progress: run.progress,
    startedAt: run.startedAt, submitAt: run.submitAt,
    homeworks: run.homeworks.map(({ id, title, status, progress, result }) => ({
      id, title, status, progress,
      ...(result && { result: { submitted: result.submitted, score: result.score, error: result.error } }),
    })),
    logs: run.logs.slice(-80).map((log) => ({ ...log, message: String(log.message).slice(0, 400) })),
  };
}

const jobs = {
  async enqueue({ session, homeworks, config, license }) {
    const id = randomUUID();
    const owner = session.username.trim().toLowerCase();
    const snapshot = { id, status: 'queued', phase: 'queued', homeworks: homeworks.map(({ id, title }) => ({ id, title, status: 'pending' })), logs: [] };
    await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(839202)');
      const active = await client.query("SELECT 1 FROM olm_jobs WHERE owner=$1 AND status IN ('queued', 'running')", [owner]);
      if (active.rowCount) throw Object.assign(new Error('Tài khoản đang có một tác vụ đang chờ hoặc đang chạy.'), { status: 409 });
      const capacity = integer(process.env.MAX_QUEUED_RUNS, 250, 1, 10000);
      const count = await client.query("SELECT count(*) FROM olm_jobs WHERE status IN ('queued', 'running')");
      if (Number(count.rows[0].count) >= capacity) throw unavailable('Hàng đợi đang đầy. Vui lòng thử lại sau.');
      await client.query("INSERT INTO olm_jobs (id,session_id,owner,status,payload,snapshot) VALUES ($1,$2,$3,'queued',$4,$5)",
        [id, session.id, owner, { homeworks, config, license }, snapshot]);
    });
    return { id, status: 'queued', homeworks };
  },
  async get(id, sessionId) {
    const { rows } = await query('SELECT status, snapshot FROM olm_jobs WHERE id=$1 AND session_id=$2', [id, sessionId]);
    return rows[0] ? { ...rows[0].snapshot, status: rows[0].status } : null;
  },
  async list(sessionId) {
    const { rows } = await query('SELECT status, snapshot FROM olm_jobs WHERE session_id=$1 ORDER BY created_at DESC LIMIT 30', [sessionId]);
    return rows.map(({ status, snapshot }) => ({ ...snapshot, status, logs: undefined }));
  },
  async stop(sessionId, id = null) {
    const { rows } = await query(`
      UPDATE olm_jobs SET cancel_requested=true,
        status=CASE WHEN status='queued' THEN 'stopped' ELSE status END,
        payload=CASE WHEN status='queued' THEN '{}'::jsonb ELSE payload END,
        updated_at=CASE WHEN status='queued' THEN now() ELSE updated_at END
      WHERE session_id=$1 AND ($2::text IS NULL OR id=$2) AND status IN ('queued','running')
      RETURNING status
    `, [sessionId, id]);
    return rows[0]?.status || null;
  },
  async claim() {
    const { rows } = await query(`
      WITH next_job AS (
        SELECT id FROM olm_jobs WHERE status='queued' AND NOT cancel_requested
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE olm_jobs SET status='running', updated_at=now()
      FROM next_job WHERE olm_jobs.id=next_job.id
      RETURNING olm_jobs.id, olm_jobs.session_id, olm_jobs.payload
    `);
    return rows[0] || null;
  },
  async heartbeat(id, snapshot) {
    const { rows } = await query(`
      UPDATE olm_jobs SET snapshot=$2, updated_at=now()
      WHERE id=$1 AND status='running' RETURNING cancel_requested
    `, [id, snapshot]);
    return !rows.length || rows[0].cancel_requested;
  },
  async finish(id, snapshot) {
    await query("UPDATE olm_jobs SET status=$2, snapshot=$3, payload='{}', updated_at=now() WHERE id=$1 AND status='running'",
      [id, snapshot.status, snapshot]);
  },
  async sweep() {
    // A lost worker may already have submitted upstream. Keep the run visible and never replay it automatically.
    await query(`
      UPDATE olm_jobs SET status='error', snapshot=snapshot || '{"phase":"error","error":"Worker mất kết nối. Kiểm tra trạng thái bài trên OLM trước khi thử lại."}',
        payload='{}', updated_at=now()
      WHERE status='running' AND updated_at < now() - interval '2 minutes'
    `);
    await query(`
      UPDATE olm_jobs SET status='error', snapshot=snapshot || '{"phase":"error","error":"Tác vụ đã hết thời gian chờ."}',
        payload='{}', updated_at=now()
      WHERE status='queued' AND created_at < now() - interval '2 hours'
    `);
    await query("DELETE FROM olm_jobs WHERE status NOT IN ('queued','running') AND updated_at < now() - interval '24 hours'");
    await query('DELETE FROM olm_sessions WHERE expires_at <= now()');
    await query('DELETE FROM olm_admin_sessions WHERE expires_at <= now()');
  },
};

module.exports = { configured, init, query, sessions, adminSessions, licenses, settings, jobs, runSnapshot, close: () => pool?.end() };

