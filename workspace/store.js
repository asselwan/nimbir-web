export const kinds = new Set(['denial', 'unpaid_claim', 'remittance_line']);
export const statuses = new Set(['open', 'in_progress', 'blocked', 'done']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sourceRef = /^SYN-[A-Za-z0-9_-]{1,80}$/;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function validId(value, label) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new HttpError(400, `Invalid ${label}`);
  return value;
}
function due(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, 'Invalid sla_due_at');
  }
  return new Date(value).toISOString();
}
function input(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
  const allowed = partial ? ['owner_id', 'status', 'sla_due_at', 'title'] : ['kind', 'source_ref', 'title', 'owner_id', 'status', 'sla_due_at'];
  if (Object.keys(body).some((k) => !allowed.includes(k)) || (partial && !Object.keys(body).length)) throw new HttpError(400, 'Unsupported field');
  if (!partial || 'kind' in body) if (!kinds.has(body.kind)) throw new HttpError(400, 'Invalid kind');
  if (!partial || 'source_ref' in body) if (typeof body.source_ref !== 'string' || !sourceRef.test(body.source_ref)) throw new HttpError(400, 'Synthetic source_ref required');
  if (!partial || 'title' in body) if (typeof body.title !== 'string' || !body.title.startsWith('Synthetic ') || body.title.trim().length < 11 || body.title.length > 200) throw new HttpError(400, 'Synthetic title required');
  if ('owner_id' in body && body.owner_id !== null) validId(body.owner_id, 'owner_id');
  if ('status' in body && !statuses.has(body.status)) throw new HttpError(400, 'Invalid status');
  if (!partial || 'sla_due_at' in body) due(body.sla_due_at);
  return body;
}

// The triage filter set is deliberately small and closed: the same vocabulary
// the queue is built from, so a filter can never widen into a free-text query.
// Values are bound as parameters, never interpolated into SQL.
export const triageFilters = ['status', 'kind', 'needs_owner', 'overdue'];

function queueFilter(filters = {}) {
  const clauses = [];
  const args = [];
  // $1 is always the hospital id, so the first filter parameter is $2.
  const push = (value) => { args.push(value); return `$${args.length + 1}`; };
  if (filters.status !== undefined && filters.status !== null && filters.status !== '') {
    if (!statuses.has(filters.status)) throw new HttpError(400, 'Invalid status filter');
    clauses.push(`status = ${push(filters.status)}`);
  }
  if (filters.kind !== undefined && filters.kind !== null && filters.kind !== '') {
    if (!kinds.has(filters.kind)) throw new HttpError(400, 'Invalid kind filter');
    clauses.push(`kind = ${push(filters.kind)}`);
  }
  if (filters.needs_owner) clauses.push('owner_id IS NULL');
  if (filters.overdue) { clauses.push("status <> 'done'"); clauses.push('sla_due_at < now()'); }
  return { clauses, args };
}

export function createStore(pool) {
  async function member(hospitalId, userId, db = pool) {
    validId(hospitalId, 'hospital_id'); validId(userId, 'user_id');
    const found = await db.query('SELECT 1 FROM nimbir.hospital_member WHERE hospital_id = $1 AND user_id = $2', [hospitalId, userId]);
    if (!found.rowCount) throw new HttpError(404, 'Hospital not found');
  }
  async function transact(hospitalId, userId, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('nimbir.actor_id', $1, true)", [userId]);
      await member(hospitalId, userId, client);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23503') throw new HttpError(400, 'Owner must be a hospital member');
      if (error.code === '23505') throw new HttpError(409, 'Work item already exists');
      // A check-constraint or policy failure is not ordinary bad input: it means the
      // database rule and the code disagree. Log it before answering, so drift is
      // visible in the service log instead of looking like a user error.
      if (error.code === '23514') {
        console.error(JSON.stringify({ level: 'error', event: 'workspace_constraint_rejected', code: error.code, message: error.message }));
        throw new HttpError(400, 'Value rejected by the workspace constraints');
      }
      if (error.code === '42501') {
        console.error(JSON.stringify({ level: 'error', event: 'workspace_policy_refused', code: error.code, message: error.message }));
        throw new HttpError(403, 'Not permitted');
      }
      throw error;
    } finally { client.release(); }
  }
  async function readAs(userId, fn) {
    validId(userId, 'user_id');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('nimbir.actor_id', $1, true)", [userId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  return {
    async hospitals(userId) {
      return readAs(userId, async (db) => (await db.query('SELECT h.id, h.name, m.role FROM nimbir.hospital h JOIN nimbir.hospital_member m ON m.hospital_id = h.id WHERE m.user_id = $1 ORDER BY h.name', [userId])).rows);
    },
    async queue(hospitalId, userId, filters = {}) {
      const { clauses, args } = queueFilter(filters);
      const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
      return readAs(userId, async (db) => {
        await member(hospitalId, userId, db);
        return (await db.query(`SELECT id, kind, source_ref, title, owner_id, status, sla_due_at, created_at, updated_at FROM nimbir.work_item WHERE hospital_id = $1${where} ORDER BY (status = 'done'), sla_due_at, id LIMIT 500`, [hospitalId, ...args])).rows;
      });
    },
    // The triage summary counts the whole hospital queue, not a filtered slice:
    // it answers "how much of this is waiting, and what is late" so the queue
    // can be worked rather than merely read.
    async triage(hospitalId, userId) {
      return readAs(userId, async (db) => {
        await member(hospitalId, userId, db);
        const rows = (await db.query(`SELECT
          count(*)::int AS total,
          (count(*) FILTER (WHERE status = 'open'))::int AS open,
          (count(*) FILTER (WHERE status = 'in_progress'))::int AS in_progress,
          (count(*) FILTER (WHERE status = 'blocked'))::int AS blocked,
          (count(*) FILTER (WHERE status = 'done'))::int AS done,
          (count(*) FILTER (WHERE owner_id IS NULL))::int AS unowned,
          (count(*) FILTER (WHERE status <> 'done' AND sla_due_at < now()))::int AS overdue,
          (count(*) FILTER (WHERE kind = 'denial'))::int AS denial,
          (count(*) FILTER (WHERE kind = 'unpaid_claim'))::int AS unpaid_claim,
          (count(*) FILTER (WHERE kind = 'remittance_line'))::int AS remittance_line,
          min(sla_due_at) FILTER (WHERE status <> 'done') AS next_due_at
          FROM nimbir.work_item WHERE hospital_id = $1`, [hospitalId])).rows;
        const summary = { total: 0, open: 0, in_progress: 0, blocked: 0, done: 0, unowned: 0, overdue: 0, denial: 0, unpaid_claim: 0, remittance_line: 0, next_due_at: null };
        const row = rows[0] || {};
        for (const key of Object.keys(summary)) {
          if (row[key] === undefined || row[key] === null) continue;
          summary[key] = key === 'next_due_at' ? new Date(row[key]).toISOString() : Number(row[key]);
        }
        return summary;
      });
    },
    async audit(hospitalId, userId, itemId) {
      validId(itemId, 'item_id');
      return readAs(userId, async (db) => {
        await member(hospitalId, userId, db);
        return (await db.query('SELECT id, actor_id, action, before_state, after_state, occurred_at FROM nimbir.work_item_audit WHERE hospital_id = $1 AND work_item_id = $2 ORDER BY id LIMIT 500', [hospitalId, itemId])).rows;
      });
    },
    async create(hospitalId, userId, body) {
      input(body);
      return transact(hospitalId, userId, async (db) => {
        const result = await db.query('INSERT INTO nimbir.work_item (hospital_id, kind, source_ref, title, owner_id, status, sla_due_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [hospitalId, body.kind, body.source_ref, body.title.trim(), body.owner_id ?? null, body.status ?? 'open', due(body.sla_due_at)]);
        return result.rows[0];
      });
    },
    async update(hospitalId, userId, itemId, body) {
      validId(itemId, 'item_id'); input(body, true);
      return transact(hospitalId, userId, async (db) => {
        const keys = Object.keys(body);
        const values = keys.map((k) => k === 'sla_due_at' ? due(body[k]) : k === 'title' ? body[k].trim() : body[k]);
        const set = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
        const result = await db.query(`UPDATE nimbir.work_item SET ${set} WHERE hospital_id = $1 AND id = $2 RETURNING *`, [hospitalId, itemId, ...values]);
        if (!result.rowCount) throw new HttpError(404, 'Work item not found');
        return result.rows[0];
      });
    },
  };
}
