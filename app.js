const $ = (selector) => document.querySelector(selector);
const state = { algorithm: 'linear', sort: 'id', direction: 'asc', students: [], editingId: null, benchmark: null, toastTimer: null };

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 405 || response.status === 501) {
      throw new Error('The page is running on a static preview, which cannot handle database requests. Start this project with start.bat or run "python server.py", then open http://127.0.0.1:8000.');
    }
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function initials(name) { return String(name).trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join(''); }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2500); }
function setOnline(online) { $('.server-status').innerHTML = `<i style="background:${online ? '#42a87b' : '#ca5a4e'}"></i> ${online ? 'System online' : 'Reconnecting…'}`; }

async function loadStudents() {
  const search = $('#filterInput').value.trim();
  $('#studentRows').innerHTML = '<tr><td class="loading-cell" colspan="5">Loading records…</td></tr>';
  try {
    const params = new URLSearchParams({ q: search, sort: state.sort, direction: state.direction });
    const data = await api(`/api/students?${params}`);
    state.students = data.students;
    renderStudents(data.total);
    setOnline(true);
  } catch (error) {
    setOnline(false);
    $('#studentRows').innerHTML = `<tr><td class="empty-cell" colspan="5">${escapeHtml(error.message)}. Start the app with <code>python server.py</code>.</td></tr>`;
    $('#tableSummary').textContent = 'Could not connect to the database.';
  }
}
function renderStudents(count) {
  const rows = state.students;
  $('#studentRows').innerHTML = rows.length ? rows.map(student => {
    const date = new Date(`${student.updated_at.replace(' ', 'T')}Z`);
    const updated = Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const gpaClass = student.gpa >= 9 ? 'gpa-chip high' : 'gpa-chip';
    return `<tr>
      <td><div class="student-cell"><span class="student-avatar">${escapeHtml(initials(student.name))}</span><div><div class="student-name">${escapeHtml(student.name)}</div><div class="student-id">${escapeHtml(student.id)}</div></div></div></td>
      <td><span class="department-label">${escapeHtml(student.department)}</span></td>
      <td><span class="${gpaClass}">${Number(student.gpa).toFixed(2)}</span></td><td>${updated}</td>
      <td class="actions-cell"><button class="row-action" data-edit="${escapeHtml(student.id)}" title="Edit record" aria-label="Edit ${escapeHtml(student.name)}">Edit</button><button class="row-action delete" data-delete="${escapeHtml(student.id)}" title="Delete record" aria-label="Delete ${escapeHtml(student.name)}">×</button></td></tr>`;
  }).join('') : `<tr><td class="empty-cell" colspan="5">${$('#filterInput').value ? 'No records match this filter.' : 'There are no student records yet. Add a student to get started.'}</td></tr>`;
  $('#recordCount').textContent = `${count} record${count === 1 ? '' : 's'}`;
  $('#navCount').textContent = count;
  $('#tableSummary').textContent = `Showing ${count} student${count === 1 ? '' : 's'}`;
  loadSummary();
}
async function loadSummary() {
  try {
    const data = await api('/api/summary');
    $('#totalStat').textContent = data.total.toLocaleString();
    $('#gpaStat').textContent = Number(data.average_gpa).toFixed(2);
    $('#topGpaStat').textContent = Number(data.top_gpa).toFixed(2);
    $('#departmentStat').textContent = data.top_department;
  } catch { /* The directory reports connectivity failures. */ }
}

const dialog = $('#studentDialog');
function openDialog(student = null) {
  state.editingId = student?.id ?? null;
  $('#studentForm').reset(); $('#dialogError').textContent = '';
  $('#dialogEyebrow').textContent = student ? 'EDIT RECORD' : 'NEW RECORD';
  $('#dialogTitle').textContent = student ? 'Update student' : 'Add a student';
  $('#saveButton').textContent = student ? 'Save changes' : 'Save student';
  if (student) for (const [key, value] of Object.entries(student)) { const field = $('#studentForm').elements.namedItem(key); if (field) field.value = value; }
  dialog.showModal();
  $('#studentForm').elements.namedItem('id').focus();
}
function closeDialog() { dialog.close(); }
$('#addButton').addEventListener('click', () => openDialog());
$('#closeDialog').addEventListener('click', closeDialog); $('#cancelDialog').addEventListener('click', closeDialog);
dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
$('#studentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries()); payload.gpa = Number(payload.gpa);
  const originalId = state.editingId;
  const button = $('#saveButton'); button.disabled = true; button.textContent = 'Saving…'; $('#dialogError').textContent = '';
  try {
    await api(originalId ? `/api/students/${encodeURIComponent(originalId)}` : '/api/students', { method: originalId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeDialog(); showToast(originalId ? 'Student record updated.' : 'Student record saved to database.'); await loadStudents();
  } catch (error) { $('#dialogError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = originalId ? 'Save changes' : 'Save student'; }
});

$('#studentRows').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit]');
  if (edit) { const record = state.students.find(student => student.id === edit.dataset.edit); if (record) openDialog(record); return; }
  const remove = event.target.closest('[data-delete]');
  if (remove) {
    const record = state.students.find(student => student.id === remove.dataset.delete);
    if (!record || !confirm(`Delete ${record.name} (${record.id}) from the database?`)) return;
    try { await api(`/api/students/${encodeURIComponent(record.id)}`, { method: 'DELETE' }); showToast('Student record deleted.'); await loadStudents(); }
    catch (error) { showToast(error.message); }
  }
});

let filterTimer;
$('#filterInput').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(loadStudents, 220); });
$('#sortSelect').addEventListener('change', event => { state.sort = event.target.value; loadStudents(); });
$('#directionButton').addEventListener('click', event => { state.direction = state.direction === 'asc' ? 'desc' : 'asc'; event.currentTarget.textContent = state.direction === 'asc' ? '↑' : '↓'; loadStudents(); });
$('#refreshButton').addEventListener('click', () => { loadStudents(); showToast('Records refreshed from SQLite.'); });
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#filterInput').focus(); } });

document.querySelectorAll('.segment').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.segment').forEach(item => item.classList.toggle('active', item === button));
  state.algorithm = button.dataset.algorithm;
}));
async function searchStudent() {
  const query = $('#searchInput').value.trim();
  if (!query) { $('#searchInput').focus(); $('#searchResult').className = 'search-result failure'; $('#searchResult').innerHTML = '<span class="result-symbol">!</span><span>Enter a student ID or full name to search.</span>'; return; }
  const button = $('#searchButton'); button.disabled = true; button.textContent = 'Searching…';
  try {
    const data = await api('/api/search', { method: 'POST', body: JSON.stringify({ query, field: $('#searchField').value, algorithm: state.algorithm }) });
    const result = $('#searchResult');
    if (data.found) {
      result.className = 'search-result success';
      result.innerHTML = `<span class="result-symbol">✓</span><span><b>${escapeHtml(data.student.name)}</b> · ${escapeHtml(data.student.id)} · GPA ${Number(data.student.gpa).toFixed(2)}<br>${state.algorithm === 'linear' ? 'Linear' : 'Binary'} search · ${data.comparisons} comparison${data.comparisons === 1 ? '' : 's'} · ${formatTime(data.elapsed_ns)} · ${data.dataset_size} records${data.preparation_note ? ' · Sorted copy prepared' : ''}</span>`;
    } else {
      result.className = 'search-result failure';
      result.innerHTML = `<span class="result-symbol">×</span><span>No exact ${$('#searchField').value === 'id' ? 'ID' : 'name'} match for “${escapeHtml(query)}”. ${data.comparisons} comparison${data.comparisons === 1 ? '' : 's'} across ${data.dataset_size} records.</span>`;
    }
  } catch (error) { $('#searchResult').className = 'search-result failure'; $('#searchResult').textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Search'; }
}
function formatTime(ns) { return ns < 1_000_000 ? `${(ns / 1000).toFixed(2)} µs` : `${(ns / 1_000_000).toFixed(3)} ms`; }
$('#searchButton').addEventListener('click', searchStudent);
$('#searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') searchStudent(); });

$('#benchmarkButton').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true; button.innerHTML = '<span>◌</span> Analyzing…';
  $('#chartEmpty').style.display = 'flex'; $('#chartEmpty').innerHTML = '<span>◌</span><b>Benchmark running</b><small>Measuring repeated searches in Python.</small>';
  try {
    const data = await api('/api/benchmark', { method: 'POST', body: '{}' });
    state.benchmark = data.results; drawChart(data.results); $('#chartEmpty').style.display = 'none';
    $('#benchmarkDetail').textContent = `Completed · ${data.results.length} input sizes`;
    showToast('Performance benchmark completed.');
  } catch (error) { $('#chartEmpty').style.display = 'flex'; $('#chartEmpty').innerHTML = `<span>!</span><b>Benchmark unavailable</b><small>${escapeHtml(error.message)}</small>`; }
  finally { button.disabled = false; button.innerHTML = '<span>▶</span> Run benchmark'; }
});

function drawChart(results) {
  const canvas = $('#performanceChart'), ratio = window.devicePixelRatio || 1, box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return;
  canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  const w = box.width, h = box.height, pad = { left: 43, right: 12, top: 10, bottom: 26 }, plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
  ctx.clearRect(0, 0, w, h);
  if (!results?.length) return;
  const max = Math.max(...results.map(point => point.linear_ns / 1e6)) * 1.16 || 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + plotH * i / 4, value = max * (1 - i / 4);
    ctx.beginPath(); ctx.strokeStyle = '#e9eeea'; ctx.lineWidth = 1; ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#929d95'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right'; ctx.fillText(value < .01 ? `${(value * 1000).toFixed(1)}µs` : `${value.toFixed(2)}ms`, pad.left - 6, y + 3);
  }
  for (const [field, color] of [['linear_ns', '#176d50'], ['binary_ns', '#d69133']]) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2.1;
    results.forEach((point, index) => { const x = pad.left + (results.length === 1 ? plotW / 2 : plotW * index / (results.length - 1)); const y = pad.top + plotH * (1 - (point[field] / 1e6) / max); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    results.forEach((point, index) => { const x = pad.left + (results.length === 1 ? plotW / 2 : plotW * index / (results.length - 1)); const y = pad.top + plotH * (1 - (point[field] / 1e6) / max); ctx.beginPath(); ctx.fillStyle = color; ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); });
  }
  ctx.fillStyle = '#87938b'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  results.forEach((point, index) => { const x = pad.left + (results.length === 1 ? plotW / 2 : plotW * index / (results.length - 1)); ctx.fillText(point.size >= 1000 ? `${point.size / 1000}k` : point.size, x, h - 7); });
}
let resizeTimer; window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => drawChart(state.benchmark), 100); });

loadStudents();
