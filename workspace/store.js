const kinds = new Set(['denial', 'unpaid_claim', 'remittance_line']);
const statuses = new Set(['open', 'in_progress', 'blocked', 'done']);
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
  if (!partial || 'title' in body) if (typeof body.title !== 'string' || !body.title.startsWith('Synthetic ') || body.title.length > 200) throw new HttpError(400, 'Synthetic title required');
  if ('owner_id' in body && body.owner_id !== null) validId(body.owner_id, 'owner_id');
  if ('status' in body && !statuses.has(body.status)) throw new HttpError(400, 'Invalid status');
  if (!partial || 'sla_due_at' in body) due(body.sla_due_at);
  return body;
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
    async queue(hospitalId, userId) {
      return readAs(userId, async (db) => {
        await member(hospitalId, userId, db);
        return (await db.query('SELECT id, kind, source_ref, title, owner_id, status, sla_due_at, created_at, updated_at FROM nimbir.work_item WHERE hospital_id = $1 ORDER BY (status = \'done\'), sla_due_at, id LIMIT 500', [hospitalId])).rows;
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
