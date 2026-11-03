// Convert classified, synthetic 835 rows into the workspace store's create
// bodies. References use the caller's fixture ID and row position, never a
// patient or payer claim identifier. The three-day target is an internal review
// target from import time, not a payer filing deadline.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NimbirToWorkItem = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toWorkItems(rows, options) {
    if (!Array.isArray(rows)) throw new TypeError('Claim rows required');
    const sourceId = options && options.sourceId;
    if (typeof sourceId !== 'string' || !/^[A-Z0-9][A-Z0-9-]{0,40}$/.test(sourceId)) {
      throw new TypeError('Synthetic fixture sourceId required');
    }
    const now = options && options.now ? new Date(options.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid import time');
    const slaDueAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const items = [];
    rows.forEach((row, index) => {
      if (row.state === 'Ready') return;
      const kind = row.state === 'Needs approval' ? 'denial' : 'unpaid_claim';
      const context = `${row.line_id || 'remittance line'} · ${row.denial_category || 'Review required'}`;
      const action = row.next_action || 'Review this remittance line before closing it.';
      items.push({
        kind,
        source_ref: `SYN-${sourceId}-${String(index + 1).padStart(3, '0')}`,
        title: `Synthetic ${context} — ${action}`.slice(0, 200),
        status: 'open',
        sla_due_at: slaDueAt,
      });
    });
    return items;
  }

  return { toWorkItems };
});
