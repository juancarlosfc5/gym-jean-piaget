const $ = id => document.getElementById(id);
const isReport = document.body.dataset.view === 'tablero';
const dayLabel = new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
const monthLabel = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const normal = value => value.toLocaleLowerCase('es').normalize('NFD').replace(/\p{Diacritic}/gu, '');
const sessionDialog = $('profile-dialog');
const model = {
  profile: null, groups: [], people: [], selection: new Set(), correction: false,
  pending: null, saving: false, contextVersion: 0, reportRows: [],
};

function message(id, text = '', kind = '') {
  $(id).textContent = text;
  $(id).dataset.kind = kind;
}

async function api(action, input = {}) {
  const response = await fetch('/api/piloto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, input }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'No se pudo conectar con el piloto. Intenta de nuevo.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function options(id, entries, selected) {
  const control = $(id);
  control.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  if (entries.some(([value]) => value === selected)) control.value = selected;
  control.disabled = !entries.length;
}

function showProfile() {
  message('profile-status');
  if (!sessionDialog.open) sessionDialog.showModal();
}

for (const button of document.querySelectorAll('[data-open-profile]')) button.addEventListener('click', showProfile);
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const { profile } = await api('sesion', { profile: $('perfil').value });
    if (!isReport && profile === 'cartera') { window.location.href = '/tablero'; return; }
    if (isReport && profile !== 'admin' && profile !== 'cartera') { window.location.href = '/'; return; }
    sessionDialog.close();
    await initialize();
  } catch (error) { message('profile-status', error.message, 'error'); }
  finally { button.disabled = false; }
});

async function initialize() {
  try {
    const current = await api('iniciar');
    model.profile = current.profile;
    model.groups = current.groups;
    $('profile-label').textContent = current.profile.name;
    if (isReport && current.profile.role === 'operador') {
      message('report-status', 'El tablero está disponible para cartera y coordinación.', 'error');
      return;
    }
    if (!isReport && current.profile.role === 'cartera') {
      window.location.href = '/tablero';
      return;
    }
    if (isReport) {
      options('mes', current.months.map(month => [month, monthLabel.format(new Date(month + '-01T12:00:00Z'))]));
      options('sede', [['', 'Todas'], ...[...new Set(current.groups.map(group => group.site))].map(site => [site, site])]);
      $('servicio-filtro').disabled = false;
      $('reset').disabled = false;
      $('buscar-tablero').disabled = false;
      populateDependentFilters();
      await loadReport();
    } else {
      options('fecha', current.dates.map(date => [date, dayLabel.format(new Date(date + 'T12:00:00Z'))]), '2027-02-11');
      options('grupo', current.groups.map(group => [group.id, group.name]));
      $('manage').hidden = current.profile.role !== 'admin';
      $('toggle-correction').hidden = current.profile.role !== 'admin';
      $('buscar').disabled = false;
      await loadRoster();
    }
  } catch (error) {
    if (error.status === 401) showProfile();
    else message(isReport ? 'report-status' : 'roster-state', error.message, 'error');
  }
}

function activeContext() {
  return {
    date: $('fecha').value, group: $('grupo').value,
    service: document.querySelector('input[name=servicio]:checked')?.value,
  };
}

function updateCount() {
  $('selected-count').querySelector('strong').textContent = model.selection.size;
  $('guardar').disabled = model.saving || !model.selection.size || (model.correction && !$('motivo').value);
  $('guardar').textContent = model.saving ? 'Guardando…' : model.correction ? 'Anular seleccionadas' : 'Guardar entregas';
}

function visiblePeople() {
  const term = normal($('buscar').value.trim());
  return model.people.filter(person => normal(person.name).includes(term));
}

function renderRoster() {
  const visible = visiblePeople();
  $('select-shown').disabled = model.saving || !visible.some(p => p.marked === model.correction && !model.selection.has(p.id));
  const fragment = document.createDocumentFragment();
  for (const person of visible) {
    const item = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'person';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = model.selection.has(person.id);
    check.disabled = model.saving || person.marked !== model.correction;
    check.setAttribute('aria-label', person.name);
    check.addEventListener('change', () => {
      if (check.checked) model.selection.add(person.id); else model.selection.delete(person.id);
      model.pending = null;
      $('select-shown').disabled = !visiblePeople().some(p => p.marked === model.correction && !model.selection.has(p.id));
      updateCount();
    });
    const initials = document.createElement('span');
    initials.className = 'initials';
    initials.textContent = person.name.split(' ').slice(0, 2).map(word => word[0]).join('');
    initials.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = person.name;
    label.append(check, initials, name);
    if (person.marked) {
      const recorded = document.createElement('span');
      recorded.className = 'recorded';
      recorded.textContent = 'Registrada';
      label.append(recorded);
    }
    item.append(label);
    fragment.append(item);
  }
  $('lista').replaceChildren(fragment);
  updateCount();
}

async function loadRoster(feedback) {
  const version = ++model.contextVersion;
  const group = model.groups.find(g => g.id === $('grupo').value);
  if (!group) return;
  const radios = [...document.querySelectorAll('input[name=servicio]')];
  for (const radio of radios) radio.disabled = !group.services.includes(radio.value);
  if (!radios.some(radio => radio.checked && !radio.disabled)) radios.find(radio => !radio.disabled).checked = true;
  $('context-hint').textContent = group.site;
  model.selection.clear();
  model.pending = null;
  model.people = [];
  renderRoster();
  message('roster-state', 'Cargando listado…');
  try {
    const { people } = await api('listado', activeContext());
    if (version !== model.contextVersion) return;
    model.people = people;
    const marked = people.filter(person => person.marked).length;
    $('roster-subtitle').textContent = group.name + ' · ' + people.length + ' en el listado · ' + marked + ' registradas';
    message('roster-state', feedback || (people.length ? '' : 'No hay personas habilitadas en el grupo.'), feedback ? 'success' : '');
    renderRoster();
  } catch (error) {
    if (version !== model.contextVersion) return;
    message('roster-state', error.message, 'error');
    if (error.status === 401) showProfile();
  }
}

function selectVisible() {
  for (const person of visiblePeople()) if (person.marked === model.correction) model.selection.add(person.id);
  model.pending = null;
  renderRoster();
}

async function saveRoster() {
  if (!model.selection.size || model.saving) return;
  const version = model.contextVersion;
  const correction = model.correction;
  const action = correction ? 'anular' : 'marcar';
  if (!model.pending) model.pending = { ...activeContext(), people: [...model.selection], operationId: crypto.randomUUID(), ...(correction ? { reason: $('motivo').value } : {}) };
  model.saving = true;
  renderRoster();
  try {
    const result = await api(action, model.pending);
    if (version !== model.contextVersion) return;
    const label = correction ? 'anuladas' : 'registradas';
    const rest = result.unchanged ? ' · ' + result.unchanged + ' sin cambio' : '';
    await loadRoster(result.saved + ' ' + label + rest + (result.replayed ? ' · operación recuperada' : ''));
  } catch (error) {
    if (version === model.contextVersion) message('roster-state', error.message, 'error');
    if (error.status === 401) showProfile();
  } finally {
    model.saving = false;
    renderRoster();
  }
}

function populateDependentFilters() {
  const groupValue = $('grupo-filtro').value;
  const site = $('sede').value;
  const groups = model.groups.filter(g => !site || g.site === site);
  options('grado', [['', 'Todos'], ...[...new Set(groups.map(g => g.grade))].map(grade => [grade, grade])], $('grado').value);
  const grade = $('grado').value;
  options('grupo-filtro', [['', 'Todos'], ...groups.filter(g => !grade || g.grade === grade).map(g => [g.id, g.name])], groupValue);
}

function chart(daily) {
  const panel = $('grafica');
  if (!daily.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = 'No hay entregas con los filtros actuales.';
    panel.replaceChildren(empty);
    return;
  }
  const max = Math.max(...daily.map(d => d.merienda + d.almuerzo));
  panel.replaceChildren(...daily.map(day => {
    const row = document.createElement('div');
    row.className = 'chart-row';
    row.setAttribute('aria-label', day.date + ': ' + day.merienda + ' meriendas y ' + day.almuerzo + ' almuerzos');
    row.title = day.merienda + ' meriendas · ' + day.almuerzo + ' almuerzos';
    const label = document.createElement('span');
    label.textContent = day.date.slice(8) + '/' + day.date.slice(5, 7);
    const track = document.createElement('div');
    track.className = 'chart-track';
    for (const service of ['merienda', 'almuerzo']) {
      const bar = document.createElement('span');
      bar.className = 'chart-bar';
      bar.style.setProperty('--width', (100 * day[service] / max) + '%');
      track.append(bar);
    }
    const total = document.createElement('strong');
    total.textContent = day.merienda + day.almuerzo;
    row.append(label, track, total);
    return row;
  }));
}

function filteredRows() {
  const search = normal($('buscar-tablero').value.trim());
  return model.reportRows.filter(person => normal(person.name).includes(search));
}

function displayReportTable() {
  const rows = filteredRows();
  const groupNames = new Map(model.groups.map(g => [g.id, g.name]));
  $('tabla').replaceChildren(...rows.map(person => {
    const row = document.createElement('tr');
    for (const value of [person.name, groupNames.get(person.group) || person.group, person.merienda, person.almuerzo, person.merienda + person.almuerzo]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  $('detail-count').textContent = rows.length ? rows.length + ' filas en el detalle' : 'Sin entregas con esta selección.';
  $('exportar').disabled = !rows.length;
}

async function loadReport() {
  if (!$('mes').value || model.profile?.role === 'operador') return;
  const version = ++model.contextVersion;
  message('report-status', 'Actualizando tablero…');
  $('exportar').disabled = true;
  try {
    const report = await api('tablero', { month: $('mes').value, site: $('sede').value, grade: $('grado').value, group: $('grupo-filtro').value, service: $('servicio-filtro').value });
    if (version !== model.contextVersion) return;
    $('metrica-personas').textContent = report.totals.people;
    $('metrica-meriendas').textContent = report.totals.merienda;
    $('metrica-almuerzos').textContent = report.totals.almuerzo;
    model.reportRows = report.rows;
    message('report-status');
    chart(report.daily);
    displayReportTable();
  } catch (error) {
    if (version !== model.contextVersion) return;
    for (const id of ['metrica-personas', 'metrica-meriendas', 'metrica-almuerzos']) $(id).textContent = '—';
    model.reportRows = [];
    chart([]);
    displayReportTable();
    message('report-status', error.message, 'error');
    if (error.status === 401) showProfile();
  }
}

function download() {
  const groupNames = new Map(model.groups.map(g => [g.id, g.name]));
  const rows = [['Persona', 'Grupo', 'Sede', 'Meriendas', 'Almuerzos', 'Total'], ...filteredRows().map(person =>
    [person.name, groupNames.get(person.group) || person.group, person.site, person.merienda, person.almuerzo, person.merienda + person.almuerzo])];
  const quote = value => '"' + String(value).replace(/^[=+@-]/, match => "'" + match).replaceAll('"', '""') + '"';
  const csv = '\uFEFF' + rows.map(row => row.map(quote).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'jean-piaget-' + $('mes').value + '.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

if (isReport) {
  for (const id of ['mes', 'sede', 'grado', 'grupo-filtro', 'servicio-filtro']) $(id).addEventListener('change', () => {
    if (id === 'sede' || id === 'grado') populateDependentFilters();
    loadReport();
  });
  $('reset').addEventListener('click', () => {
    for (const id of ['sede', 'grado', 'grupo-filtro', 'servicio-filtro', 'buscar-tablero']) $(id).value = '';
    populateDependentFilters();
    loadReport();
  });
  $('buscar-tablero').addEventListener('input', displayReportTable);
  $('exportar').addEventListener('click', download);
} else {
  for (const input of [$('fecha'), $('grupo'), ...document.querySelectorAll('input[name=servicio]')]) input.addEventListener('change', () => loadRoster());
  $('buscar').addEventListener('input', renderRoster);
  $('select-shown').addEventListener('click', selectVisible);
  $('guardar').addEventListener('click', saveRoster);
  $('motivo').addEventListener('change', () => { model.pending = null; updateCount(); });
  $('toggle-correction').addEventListener('click', () => {
    model.correction = !model.correction;
    model.selection.clear();
    model.pending = null;
    $('correction-fields').hidden = !model.correction;
    $('toggle-correction').textContent = model.correction ? 'Volver al registro' : 'Corregir marcaciones';
    message('roster-state', model.correction ? 'Puedes seleccionar personas con una entrega registrada.' : '');
    renderRoster();
  });
  $('manage-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('alta', { group: $('grupo').value, persona: 'PILOTO-' + $('person-code').value, active: $('person-status').value === 'active' });
      message('manage-status', result.updated ? 'Persona ficticia guardada.' : 'El registro ya estaba actualizado.', 'success');
      await loadRoster();
    } catch (error) { message('manage-status', error.message, 'error'); }
    finally { button.disabled = false; }
  });
}

initialize();
