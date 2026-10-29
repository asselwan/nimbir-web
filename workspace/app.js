let token = '';
const hospital = document.querySelector('#hospital');
const items = document.querySelector('#items');
const message = document.querySelector('#message');
const workspace = document.querySelector('#workspace');
async function api(path) {
  const response = await fetch(`/api/workspace/${path}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value;
}
async function load() {
  const rows = await api(`${hospital.value}/items`);
  items.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.status !== 'done' && Date.parse(row.sla_due_at) < Date.now()) tr.className = 'overdue';
    for (const value of [`${row.kind} · ${row.source_ref}`, row.title, row.owner_id || 'Unassigned']) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    const statusCell = document.createElement('td');
    const status = document.createElement('select');
    for (const value of ['open', 'in_progress', 'blocked', 'done']) {
      const option = document.createElement('option'); option.value = value; option.textContent = value.replace('_', ' '); status.append(option);
    }
    status.value = row.status;
    status.addEventListener('change', async () => {
      try {
        const response = await fetch(`/api/workspace/${hospital.value}/items/${row.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: status.value }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Update failed');
        await load();
      } catch (error) { status.value = row.status; message.textContent = error.message; }
    });
    statusCell.append(status); tr.append(statusCell);
    const dueCell = document.createElement('td'); dueCell.textContent = new Date(row.sla_due_at).toLocaleString(); tr.append(dueCell);
    const td = document.createElement('td');
    const button = document.createElement('button'); button.textContent = 'History';
    button.addEventListener('click', async () => {
      try {
        const audit = await api(`${hospital.value}/items/${row.id}/audit`);
        const dialog = document.createElement('dialog');
        const heading = document.createElement('h2'); heading.textContent = `History · ${row.source_ref}`;
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(audit, null, 2);
        const close = document.createElement('button'); close.textContent = 'Close'; close.addEventListener('click', () => dialog.close());
        dialog.append(heading, pre, close); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal();
      } catch (error) { message.textContent = error.message; }
    });
    td.append(button); tr.append(td); items.append(tr);
  }
  message.textContent = `${rows.length} work items`;
}
document.querySelector('#connect').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const response = await fetch('/api/workspace/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.querySelector('#email').value, password: document.querySelector('#password').value }) });
    const session = await response.json();
    document.querySelector('#password').value = '';
    if (!response.ok) throw new Error(session.error || 'Sign-in failed');
    token = session.access_token;
    const hospitals = await api('hospitals');
    hospital.replaceChildren(...hospitals.map((row) => { const option = document.createElement('option'); option.value = row.id; option.textContent = row.name; return option; }));
    if (!hospitals.length) throw new Error('No hospital membership provisioned');
    workspace.hidden = false; await load();
  } catch (error) { message.textContent = error.message; workspace.hidden = false; }
});
hospital.addEventListener('change', () => load().catch((error) => { message.textContent = error.message; }));
document.querySelector('#refresh').addEventListener('click', () => load().catch((error) => { message.textContent = error.message; }));
