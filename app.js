/* ACA · Tablero de seguimiento de APIs
 * SPA estática (sin build) para GitHub Pages.
 * Datos: data/apis.json · Borradores: localStorage · Publicación: GitHub REST API (contents).
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constantes
  // ---------------------------------------------------------------------------
  const ESTADOS_API = ['Planificada', 'En Desarrollo', 'En QA / Testing', 'En Producción', 'Bloqueada'];
  const ESTADOS_EP = ['Pendiente', 'En Progreso', 'Completado', 'Bloqueado'];
  const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'EVENT/ASYNC', 'FEATURE'];
  const DIAS_PROXIMA = 14;
  const DATA_URL = 'data/apis.json';
  const GH_API = 'https://api.github.com';
  const LS = {
    draft: 'aca-apis:draft',
    config: 'aca-apis:github-config',
    token: 'aca-apis:github-token',
    view: 'aca-apis:view',
  };

  const state = {
    data: { version: 1, actualizado: null, apis: [] },
    source: '',
    hasDraft: false,
    draftSavedAt: null,
    remoteSha: null,
    view: 'cards',
    detailApiId: null,
    saving: false,
    loadError: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function str(v) {
    return v == null ? '' : String(v).trim();
  }

  function uniq(list) {
    return Array.from(new Set(list));
  }

  function slug(text) {
    return str(text)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function fold(text) {
    return str(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function sortEs(list) {
    return list.slice().sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  }

  const lsGet = (key) => {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  };
  const lsSet = (key, value) => {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  };
  const lsDel = (key) => {
    try { localStorage.removeItem(key); } catch (e) { /* ignorado */ }
  };
  const lsJSON = (key) => {
    const raw = lsGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };

  // Fechas en formato YYYY-MM-DD interpretadas en hora local.
  function parseDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function validDateStr(v) {
    const s = str(v);
    return parseDate(s) ? s : '';
  }

  function today() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function daysUntil(s) {
    const d = parseDate(s);
    if (!d) return null;
    return Math.round((d - today()) / 86400000);
  }

  function fmtDate(s) {
    const d = parseDate(s);
    return d ? d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Sin fecha';
  }

  function fmtDateTime(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  }

  function dateStatus(fecha, done) {
    if (done) return '';
    const days = daysUntil(fecha);
    if (days == null) return '';
    if (days < 0) return 'overdue';
    if (days <= DIAS_PROXIMA) return 'soon';
    return '';
  }

  function relativeDays(days) {
    if (days < 0) return `Vencida hace ${-days} día${days === -1 ? '' : 's'}`;
    if (days === 0) return 'Vence hoy';
    return `Vence en ${days} día${days === 1 ? '' : 's'}`;
  }

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // ---------------------------------------------------------------------------
  // Modelo de datos
  // ---------------------------------------------------------------------------
  function normalizeEndpoint(e, apiId, index, usedIds) {
    if (!e || typeof e !== 'object') {
      throw new Error(`El endpoint #${index + 1} de "${apiId}" no es un objeto válido.`);
    }
    let id = str(e.id) || `${apiId}-ep-${String(index + 1).padStart(2, '0')}`;
    if (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    const metodo = str(e.metodo).toUpperCase();
    return {
      id,
      metodo: METODOS.includes(metodo) ? metodo : 'FEATURE',
      rutaONombre: str(e.rutaONombre) || id,
      descripcion: str(e.descripcion),
      estado: ESTADOS_EP.includes(e.estado) ? e.estado : 'Pendiente',
      responsableFeature: str(e.responsableFeature),
      fechaEstimada: validDateStr(e.fechaEstimada),
    };
  }

  function normalizeApi(a, index) {
    if (!a || typeof a !== 'object') {
      throw new Error(`La API en la posición ${index + 1} no es un objeto válido.`);
    }
    let resp = a.responsable;
    if (typeof resp === 'string') resp = { nombre: resp, rol: '' };
    resp = { nombre: str(resp && resp.nombre), rol: str(resp && resp.rol) };

    let tags = a.desarrolloAfectado;
    if (typeof tags === 'string') tags = tags.split(',');
    tags = Array.isArray(tags) ? uniq(tags.map(str).filter(Boolean)) : [];

    const id = str(a.id) || `api-${index + 1}`;
    const eps = Array.isArray(a.endpointsFeatures) ? a.endpointsFeatures : [];
    const usedIds = new Set();
    return {
      id,
      nombre: str(a.nombre) || id,
      contexto: str(a.contexto),
      responsable: resp,
      desarrolloAfectado: tags,
      estadoGeneral: ESTADOS_API.includes(a.estadoGeneral) ? a.estadoGeneral : 'Planificada',
      fechaEstimadaEntrega: validDateStr(a.fechaEstimadaEntrega),
      endpointsFeatures: eps.map((e, j) => normalizeEndpoint(e, id, j, usedIds)),
    };
  }

  function normalizeData(raw) {
    let apis;
    if (Array.isArray(raw)) apis = raw;
    else if (raw && Array.isArray(raw.apis)) apis = raw.apis;
    else throw new Error('El JSON debe contener un arreglo "apis" (o ser directamente un arreglo de APIs).');
    const out = apis.map(normalizeApi);
    const seen = new Set();
    out.forEach((a) => {
      if (seen.has(a.id)) throw new Error(`ID de API duplicado: "${a.id}".`);
      seen.add(a.id);
    });
    return {
      version: (raw && !Array.isArray(raw) && raw.version) || 1,
      actualizado: (raw && !Array.isArray(raw) && raw.actualizado) || null,
      apis: out,
    };
  }

  function serializeData() {
    const payload = {
      version: state.data.version || 1,
      actualizado: state.data.actualizado || new Date().toISOString(),
      apis: state.data.apis,
    };
    return JSON.stringify(payload, null, 2) + '\n';
  }

  function findApi(id) {
    return state.data.apis.find((a) => a.id === id) || null;
  }

  function apiStats(api) {
    const eps = api.endpointsFeatures;
    const count = (estado) => eps.filter((e) => e.estado === estado).length;
    const done = count('Completado');
    const total = eps.length;
    let pct;
    if (total) pct = Math.round((done * 100) / total);
    else pct = api.estadoGeneral === 'En Producción' ? 100 : 0;
    return {
      total,
      done,
      pending: total - done,
      inProgress: count('En Progreso'),
      blocked: count('Bloqueado'),
      pct,
    };
  }

  function apiResponsables(api) {
    const list = [api.responsable.nombre];
    api.endpointsFeatures.forEach((e) => { if (e.responsableFeature) list.push(e.responsableFeature); });
    return uniq(list.filter(Boolean));
  }

  // ---------------------------------------------------------------------------
  // Borrador local (localStorage)
  // ---------------------------------------------------------------------------
  function saveDraft() {
    state.data.actualizado = new Date().toISOString();
    const savedAt = new Date().toISOString();
    const ok = lsSet(LS.draft, JSON.stringify({ savedAt, baseSha: state.remoteSha, data: state.data }));
    state.hasDraft = true;
    state.draftSavedAt = savedAt;
    if (!ok) toast('No se pudo guardar el borrador en este navegador (localStorage no disponible o lleno). Exportá el JSON para no perder cambios.', 'warning');
  }

  function readDraft() {
    const d = lsJSON(LS.draft);
    return d && d.data ? d : null;
  }

  function clearDraft() {
    lsDel(LS.draft);
    state.hasDraft = false;
    state.draftSavedAt = null;
  }

  function commit() {
    saveDraft();
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Configuración GitHub
  // ---------------------------------------------------------------------------
  function detectRepo() {
    const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (!m) return null;
    const owner = m[1];
    const first = location.pathname.split('/').filter(Boolean)[0];
    const repo = first && !first.includes('.') ? decodeURIComponent(first) : `${owner}.github.io`;
    return { owner, repo };
  }

  function getConfig() {
    const saved = lsJSON(LS.config) || {};
    const det = detectRepo() || {};
    return {
      owner: saved.owner || det.owner || '',
      repo: saved.repo || det.repo || '',
      branch: saved.branch || 'main',
      path: saved.path || DATA_URL,
    };
  }

  function getToken() {
    return str(lsGet(LS.token));
  }

  function isConfigured(cfg, token) {
    return Boolean(token && cfg.owner && cfg.repo && cfg.branch && cfg.path);
  }

  // ---------------------------------------------------------------------------
  // GitHub REST API
  // ---------------------------------------------------------------------------
  function ghHeaders(token, accept) {
    const h = {
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  function repoUrl(cfg) {
    return `${GH_API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  }

  function contentsUrl(cfg) {
    const path = cfg.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${repoUrl(cfg)}/contents/${path}`;
  }

  async function ghError(res, accion) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j && j.message ? j.message : '';
    } catch (e) { /* sin cuerpo JSON */ }
    let msg;
    switch (res.status) {
      case 401:
        msg = 'Token inválido o vencido (401). Revisá el Personal Access Token en "Configuración GitHub".';
        break;
      case 403:
        msg = /rate limit/i.test(detail)
          ? 'Se alcanzó el límite de solicitudes de la API de GitHub (403). Esperá unos minutos e intentá de nuevo.'
          : 'Permisos insuficientes (403). El token necesita permiso "Contents: Read and write" sobre este repositorio (y autorización SSO si la organización lo exige).';
        break;
      case 404:
        msg = 'No encontrado (404): verificá owner, repositorio, rama y ruta del archivo, y que el token tenga acceso a ese repositorio.';
        break;
      case 409:
        msg = 'Conflicto (409): el archivo cambió en el repositorio mientras editabas.';
        break;
      case 422:
        msg = 'Solicitud rechazada (422): la versión (sha) del archivo no coincide o los datos enviados no son válidos.';
        break;
      default:
        msg = `Error ${res.status} al ${accion} en GitHub.`;
    }
    const err = new Error(detail ? `${msg}\nDetalle de GitHub: ${detail}` : msg);
    err.status = res.status;
    return err;
  }

  async function ghFetch(url, options, accion) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      const err = new Error(`No se pudo conectar con api.github.com al ${accion}. Revisá tu conexión o proxy corporativo.`);
      err.status = 0;
      throw err;
    }
    if (!res.ok) throw await ghError(res, accion);
    return res;
  }

  // Devuelve { sha, text } o null si el archivo no existe.
  async function ghGetFile(cfg, token) {
    const url = `${contentsUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`;
    let res;
    try {
      res = await ghFetch(url, { headers: ghHeaders(token), cache: 'no-store' }, 'leer el archivo');
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    const j = await res.json();
    if (Array.isArray(j) || j.type !== 'file') {
      throw new Error(`La ruta "${cfg.path}" no es un archivo en el repositorio.`);
    }
    let text;
    if (j.content && j.encoding === 'base64') {
      text = base64ToUtf8(j.content);
    } else {
      // Archivos > 1 MB: la API no incluye el contenido; se pide en formato raw.
      const raw = await ghFetch(url, { headers: ghHeaders(token, 'application/vnd.github.raw+json'), cache: 'no-store' }, 'leer el archivo');
      text = await raw.text();
    }
    return { sha: j.sha, text };
  }

  async function ghPutFile(cfg, token, content, sha, message) {
    const body = { message, content: utf8ToBase64(content), branch: cfg.branch };
    if (sha) body.sha = sha;
    const res = await ghFetch(contentsUrl(cfg), {
      method: 'PUT',
      headers: Object.assign(ghHeaders(token), { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }, 'guardar el archivo');
    return res.json();
  }

  async function testConnection(cfg, token) {
    const repoRes = await ghFetch(repoUrl(cfg), { headers: ghHeaders(token), cache: 'no-store' }, 'consultar el repositorio');
    const repo = await repoRes.json();
    const canPush = repo.permissions ? Boolean(repo.permissions.push) : null;
    await ghFetch(`${repoUrl(cfg)}/branches/${encodeURIComponent(cfg.branch)}`, { headers: ghHeaders(token), cache: 'no-store' }, 'consultar la rama');
    const file = await ghGetFile(cfg, token);
    return { repo, canPush, fileExists: Boolean(file) };
  }

  // ---------------------------------------------------------------------------
  // Carga de datos
  // ---------------------------------------------------------------------------
  async function loadRemote() {
    const cfg = getConfig();
    const token = getToken();
    if (isConfigured(cfg, token)) {
      try {
        const file = await ghGetFile(cfg, token);
        if (file) {
          state.data = normalizeData(JSON.parse(file.text));
          state.remoteSha = file.sha;
          state.source = `GitHub API · ${cfg.owner}/${cfg.repo}@${cfg.branch}`;
          state.loadError = null;
          return;
        }
      } catch (e) {
        console.warn('Lectura vía GitHub API fallida, se usa el archivo publicado.', e);
        toast(`No se pudo leer desde la API de GitHub; se usa la copia publicada.\n${e.message}`, 'warning');
      }
    }
    let res;
    try {
      res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    } catch (e) {
      throw new Error(`No se pudo descargar ${DATA_URL}. Si abriste index.html con doble clic (file://), serví la carpeta con un servidor local (ver README).`);
    }
    if (!res.ok) throw new Error(`Error HTTP ${res.status} al leer ${DATA_URL}.`);
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error(`${DATA_URL} no contiene JSON válido.`);
    }
    state.data = normalizeData(json);
    state.remoteSha = null;
    state.source = `Archivo publicado · ${DATA_URL}`;
    state.loadError = null;
  }

  async function loadInitial() {
    const draft = readDraft();
    if (draft) {
      try {
        state.data = normalizeData(draft.data);
        state.remoteSha = draft.baseSha || null;
        state.hasDraft = true;
        state.draftSavedAt = draft.savedAt || null;
        state.source = 'Borrador local';
        toast('Se cargó un borrador local con cambios sin publicar en el repositorio.', 'warning');
        return;
      } catch (e) {
        console.warn('Borrador local inválido, se descarta.', e);
        clearDraft();
      }
    }
    try {
      await loadRemote();
    } catch (e) {
      console.error(e);
      state.loadError = e.message;
      state.source = 'Sin datos';
    }
  }

  // ---------------------------------------------------------------------------
  // Filtros
  // ---------------------------------------------------------------------------
  function getFilters() {
    return {
      search: fold($('#f-search').value),
      responsable: $('#f-responsable').value,
      desarrollo: $('#f-desarrollo').value,
      estado: $('#f-estado').value,
      desde: $('#f-desde').value,
      hasta: $('#f-hasta').value,
    };
  }

  function haystack(api) {
    const parts = [
      api.id, api.nombre, api.contexto, api.responsable.nombre, api.responsable.rol,
      api.estadoGeneral, api.desarrolloAfectado.join(' '),
    ];
    api.endpointsFeatures.forEach((e) => {
      parts.push(e.id, e.metodo, e.rutaONombre, e.descripcion, e.responsableFeature, e.estado);
    });
    return fold(parts.join(' \u0001 '));
  }

  function matchesFilters(api, f) {
    if (f.responsable && !apiResponsables(api).includes(f.responsable)) return false;
    if (f.desarrollo && !api.desarrolloAfectado.includes(f.desarrollo)) return false;
    if (f.estado && api.estadoGeneral !== f.estado) return false;
    if (f.desde || f.hasta) {
      const fecha = api.fechaEstimadaEntrega;
      if (!fecha) return false;
      if (f.desde && fecha < f.desde) return false;
      if (f.hasta && fecha > f.hasta) return false;
    }
    if (f.search) {
      const hay = haystack(api);
      const terms = f.search.split(/\s+/).filter(Boolean);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  }

  function fillSelect(select, values, placeholder) {
    const current = select.value;
    const list = sortEs(uniq(values.filter(Boolean)));
    if (current && !list.includes(current)) list.unshift(current);
    select.innerHTML = `<option value="">${esc(placeholder)}</option>` +
      list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    select.value = current;
  }

  function fillDatalist(el, values) {
    el.innerHTML = sortEs(uniq(values.filter(Boolean))).map((v) => `<option value="${esc(v)}"></option>`).join('');
  }

  function renderFilterOptions() {
    const apis = state.data.apis;
    const responsables = [];
    const desarrollos = [];
    apis.forEach((a) => {
      responsables.push(...apiResponsables(a));
      desarrollos.push(...a.desarrolloAfectado);
    });
    fillSelect($('#f-responsable'), responsables, 'Todos');
    fillSelect($('#f-desarrollo'), desarrollos, 'Todos');
    fillDatalist($('#dl-responsables'), responsables);
    fillDatalist($('#dl-desarrollos'), desarrollos);
  }

  // ---------------------------------------------------------------------------
  // Fragmentos de UI
  // ---------------------------------------------------------------------------
  const icn = (name, cls) => `<span class="ms${cls ? ` ${cls}` : ''}" aria-hidden="true">${name}</span>`;
  const badge = (estado) => `<span class="badge badge-${slug(estado)}">${esc(estado)}</span>`;
  const methodTag = (m) => `<span class="method method-${slug(m)}">${esc(m)}</span>`;

  function progressBar(pct) {
    return `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">` +
      `<div class="progress-bar" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;
  }

  function dateChip(fecha, done) {
    const st = dateStatus(fecha, done);
    const days = daysUntil(fecha);
    const title = st ? relativeDays(days) : '';
    const icon = st === 'overdue' ? icn('error') : st === 'soon' ? icn('schedule') : '';
    return `<span class="date-chip ${st}" title="${esc(title)}">${icon}${esc(fmtDate(fecha))}</span>`;
  }

  function tags(list) {
    if (!list.length) return '<span class="muted">—</span>';
    return `<div class="tags">${list.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
  }

  function responsableText(r) {
    return r.rol ? `${esc(r.nombre)} <span class="muted">· ${esc(r.rol)}</span>` : esc(r.nombre || '—');
  }

  // ---------------------------------------------------------------------------
  // KPIs y alertas
  // ---------------------------------------------------------------------------
  function collectAlerts(apis) {
    const items = [];
    apis.forEach((api) => {
      const apiDone = api.estadoGeneral === 'En Producción';
      const st = dateStatus(api.fechaEstimadaEntrega, apiDone);
      if (st) items.push({ tipo: 'API', st, days: daysUntil(api.fechaEstimadaEntrega), api, nombre: api.nombre });
      api.endpointsFeatures.forEach((e) => {
        const est = dateStatus(e.fechaEstimada, e.estado === 'Completado');
        if (est) items.push({ tipo: 'Endpoint', st: est, days: daysUntil(e.fechaEstimada), api, nombre: `${e.metodo} ${e.rutaONombre}` });
      });
    });
    return items.sort((a, b) => a.days - b.days);
  }

  function renderKpis(apis, alerts) {
    const total = state.data.apis.length;
    let epTotal = 0;
    let epDone = 0;
    let epProg = 0;
    let epBlock = 0;
    apis.forEach((a) => {
      const s = apiStats(a);
      epTotal += s.total;
      epDone += s.done;
      epProg += s.inProgress;
      epBlock += s.blocked;
    });
    const pct = epTotal ? Math.round((epDone * 100) / epTotal) : 0;
    const prod = apis.filter((a) => a.estadoGeneral === 'En Producción').length;
    const bloq = apis.filter((a) => a.estadoGeneral === 'Bloqueada').length;
    const overdue = alerts.filter((a) => a.st === 'overdue').length;
    const soon = alerts.filter((a) => a.st === 'soon').length;
    const filtered = apis.length !== total;

    $('#kpis').innerHTML = `
      <article class="kpi">
        <div class="kpi-label">Total de APIs</div>
        <div class="kpi-value">${apis.length}${filtered ? ` <small class="muted">/ ${total}</small>` : ''}</div>
        <div class="kpi-sub">${prod} en producción · ${bloq} bloqueada${bloq === 1 ? '' : 's'}</div>
      </article>
      <article class="kpi kpi-progress">
        <div class="kpi-label">Avance global</div>
        <div class="kpi-value">${pct}%</div>
        ${progressBar(pct)}
        <div class="kpi-sub">Endpoints/features completados sobre el total</div>
      </article>
      <article class="kpi kpi-endpoints">
        <div class="kpi-label">Endpoints / features</div>
        <div class="kpi-value">${epDone} <small class="muted">completados</small></div>
        <div class="kpi-sub">${epTotal - epDone} pendientes de ${epTotal} · ${epProg} en progreso · ${epBlock} bloqueados</div>
      </article>
      <article class="kpi kpi-alert">
        <div class="kpi-label">Alertas de entrega</div>
        <div class="kpi-value"><span class="over">${overdue}</span> <small class="muted">vencidas</small> · <span class="warn">${soon}</span> <small class="muted">próximas</small></div>
        <div class="kpi-sub">Próximas = dentro de ${DIAS_PROXIMA} días (APIs y endpoints sin completar)</div>
      </article>`;
  }

  function renderAlerts(alerts) {
    const box = $('#alerts');
    if (!alerts.length) { box.innerHTML = ''; return; }
    const hasOverdue = alerts.some((a) => a.st === 'overdue');
    box.innerHTML = `
      <details class="${hasOverdue ? 'has-overdue' : ''}" ${hasOverdue ? 'open' : ''}>
        <summary>${icn(hasOverdue ? 'error' : 'schedule', 'ms-fill')} ${alerts.length} entrega${alerts.length === 1 ? '' : 's'} vencida${alerts.length === 1 ? '' : 's'} o próxima${alerts.length === 1 ? '' : 's'}</summary>
        <ul>
          ${alerts.map((a) => `
            <li>
              <span class="date-chip ${a.st}">${esc(relativeDays(a.days))}</span>
              <span class="muted">${esc(a.tipo)}</span>
              <strong>${esc(a.nombre)}</strong>
              ${a.tipo === 'Endpoint' ? `<span class="muted">(${esc(a.api.nombre)})</span>` : ''}
              <button type="button" data-action="open-detail" data-api-id="${esc(a.api.id)}">Ver</button>
            </li>`).join('')}
        </ul>
      </details>`;
  }

  // ---------------------------------------------------------------------------
  // Listado (tarjetas / tabla)
  // ---------------------------------------------------------------------------
  function cardHtml(api) {
    const s = apiStats(api);
    return `
      <article class="api-card">
        <div class="api-card-head">
          <div>
            <h3>${esc(api.nombre)}</h3>
            <div class="api-id">${esc(api.id)}</div>
          </div>
          ${badge(api.estadoGeneral)}
        </div>
        <p class="api-context" title="${esc(api.contexto)}">${esc(api.contexto || 'Sin contexto cargado.')}</p>
        <dl class="meta">
          <dt>Responsable</dt><dd>${responsableText(api.responsable)}</dd>
          <dt>Entrega</dt><dd>${dateChip(api.fechaEstimadaEntrega, api.estadoGeneral === 'En Producción')}</dd>
        </dl>
        ${tags(api.desarrolloAfectado)}
        <div class="progress-row">
          ${progressBar(s.pct)}
          <span class="progress-label">${s.pct}%</span>
        </div>
        <div class="api-card-foot">
          <button type="button" class="btn btn-sm btn-secondary" data-action="open-detail" data-api-id="${esc(api.id)}">
            ${icn('list_alt')}Ver desglose · ${s.done}/${s.total} completados
          </button>
          <div class="card-actions">
            <button type="button" class="icon-btn" title="Editar API" aria-label="Editar API" data-action="edit-api" data-api-id="${esc(api.id)}">${icn('edit')}</button>
            <button type="button" class="icon-btn danger" title="Eliminar API" aria-label="Eliminar API" data-action="delete-api" data-api-id="${esc(api.id)}">${icn('delete')}</button>
          </div>
        </div>
      </article>`;
  }

  function tableHtml(apis) {
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>API</th><th>Responsable</th><th>Estado</th><th>Avance</th>
              <th>Endpoints</th><th>Entrega</th><th>Desarrollo afectado</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${apis.map((api) => {
              const s = apiStats(api);
              return `
                <tr>
                  <td><div class="cell-name">${esc(api.nombre)}</div><div class="api-id">${esc(api.id)}</div></td>
                  <td>${responsableText(api.responsable)}</td>
                  <td>${badge(api.estadoGeneral)}</td>
                  <td><div class="progress-row">${progressBar(s.pct)}<span class="progress-label">${s.pct}%</span></div></td>
                  <td>${s.done}/${s.total}</td>
                  <td>${dateChip(api.fechaEstimadaEntrega, api.estadoGeneral === 'En Producción')}</td>
                  <td>${tags(api.desarrolloAfectado)}</td>
                  <td class="cell-actions">
                    <button type="button" class="icon-btn" title="Ver desglose" aria-label="Ver desglose"                     data-action="open-detail" data-api-id="${esc(api.id)}">${icn('visibility')}</button>
                                        <button type="button" class="icon-btn" title="Editar API" aria-label="Editar API" data-action="edit-api" data-api-id="${esc(api.id)}">${icn('edit')}</button>
                                        <button type="button" class="icon-btn danger" title="Eliminar API" aria-label="Eliminar API" data-action="delete-api" data-api-id="${esc(api.id)}">${icn('delete')}</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function renderList(apis) {
    const list = $('#api-list');
    const total = state.data.apis.length;
    $('#list-title').textContent = apis.length === total ? `APIs (${total})` : `APIs (${apis.length} de ${total})`;
    $$('[data-action="set-view"]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === state.view));

    if (state.loadError) {
      list.className = '';
      list.innerHTML = `<div class="empty">${icn('cloud_off', 'ms-empty')}<strong>No se pudieron cargar los datos.</strong><br>${esc(state.loadError)}<br><br>
        <button type="button" class="btn btn-primary" data-action="reload-remote">${icn('sync')}Reintentar</button>
        <button type="button" class="btn btn-secondary" data-action="import-json">${icn('file_upload')}Importar JSON</button></div>`;
      return;
    }
    if (!apis.length) {
      list.className = '';
      list.innerHTML = total
        ? `<div class="empty">${icn('search_off', 'ms-empty')}Ninguna API coincide con los filtros seleccionados.<br><br><button type="button" class="btn btn-secondary" data-action="clear-filters">${icn('filter_alt_off')}Limpiar filtros</button></div>`
        : `<div class="empty">${icn('api', 'ms-empty')}Todavía no hay APIs registradas.<br><br><button type="button" class="btn btn-primary" data-action="new-api">${icn('add')}Crear la primera API</button></div>`;
      return;
    }
    if (state.view === 'table') {
      list.className = '';
      list.innerHTML = tableHtml(apis);
    } else {
      list.className = 'api-grid';
      list.innerHTML = apis.map(cardHtml).join('');
    }
  }

  function renderStatus() {
    const banner = $('#draft-banner');
    banner.hidden = !state.hasDraft;
    if (state.hasDraft) {
      $('#draft-banner-text').textContent =
        `Hay cambios locales sin publicar en el repositorio (borrador guardado ${fmtDateTime(state.draftSavedAt)}).`;
    }
    const parts = [state.source || '—'];
    parts.push(state.hasDraft ? 'cambios sin publicar' : 'sincronizado');
    if (state.data.actualizado) parts.push(`última actualización de datos: ${fmtDateTime(state.data.actualizado)}`);
    $('#source-info').textContent = parts.join(' · ');
  }

  function renderAll() {
    renderFilterOptions();
    const f = getFilters();
    const apis = state.data.apis.filter((a) => matchesFilters(a, f));
    const alerts = collectAlerts(apis);
    renderKpis(apis, alerts);
    renderAlerts(alerts);
    renderList(apis);
    renderStatus();
    if (state.detailApiId && $('#modal-detail').open) renderDetail();
  }

  // ---------------------------------------------------------------------------
  // Detalle / desglose de API
  // ---------------------------------------------------------------------------
  function openDetail(apiId) {
    if (!findApi(apiId)) return;
    state.detailApiId = apiId;
    renderDetail();
    const dlg = $('#modal-detail');
    if (!dlg.open) dlg.showModal();
  }

  function renderDetail() {
    const api = findApi(state.detailApiId);
    const box = $('#detail-content');
    if (!api) {
      $('#modal-detail').close();
      return;
    }
    const s = apiStats(api);
    const apiDone = api.estadoGeneral === 'En Producción';
    const rows = api.endpointsFeatures.map((e) => {
      const next = ESTADOS_EP[(ESTADOS_EP.indexOf(e.estado) + 1) % ESTADOS_EP.length];
      return `
        <tr>
          <td>${methodTag(e.metodo)}</td>
          <td>
            <div class="ep-route">${esc(e.rutaONombre)}</div>
            <div class="ep-desc">${esc(e.descripcion)}</div>
            <div class="api-id">${esc(e.id)}</div>
          </td>
          <td>${e.responsableFeature ? esc(e.responsableFeature) : `<span class="inherited" title="Hereda el responsable de la API">${esc(api.responsable.nombre || '—')}</span>`}</td>
          <td>${dateChip(e.fechaEstimada, e.estado === 'Completado')}</td>
          <td>
            <button type="button" class="badge badge-${slug(e.estado)}" data-action="cycle-ep" data-api-id="${esc(api.id)}" data-ep-id="${esc(e.id)}"
              title="Clic para cambiar a “${esc(next)}”">${esc(e.estado)} ${icn('sync')}</button>
          </td>
          <td class="cell-actions">
            <button type="button" class="icon-btn" title="Editar" aria-label="Editar endpoint" data-action="edit-ep" data-api-id="${esc(api.id)}" data-ep-id="${esc(e.id)}">${icn('edit')}</button>
            <button type="button" class="icon-btn danger" title="Eliminar" aria-label="Eliminar endpoint" data-action="delete-ep" data-api-id="${esc(api.id)}" data-ep-id="${esc(e.id)}">${icn('delete')}</button>
          </td>
        </tr>`;
    }).join('');

    box.innerHTML = `
      <header class="modal-header">
        <div>
          <h3>${esc(api.nombre)} ${badge(api.estadoGeneral)}</h3>
          <div class="api-id">${esc(api.id)}</div>
        </div>
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Cerrar">${icn('close')}</button>
      </header>
      <div class="modal-body">
        <div class="detail-grid">
          <div>
            <h4>Contexto</h4>
            <p>${esc(api.contexto || 'Sin contexto cargado.')}</p>
          </div>
          <dl class="meta">
            <dt>Responsable</dt><dd>${responsableText(api.responsable)}</dd>
            <dt>Entrega</dt><dd>${dateChip(api.fechaEstimadaEntrega, apiDone)}</dd>
            <dt>Afecta a</dt><dd>${tags(api.desarrolloAfectado)}</dd>
            <dt>Avance</dt>
            <dd><div class="progress-row">${progressBar(s.pct)}<span class="progress-label">${s.pct}%</span></div></dd>
          </dl>
        </div>
        <div class="detail-section-title">
          <h4>Desglose de endpoints / features (${s.done}/${s.total} completados)</h4>
          <div class="status-summary">
            ${ESTADOS_EP.map((st) => `${badge(st)}<span>${api.endpointsFeatures.filter((e) => e.estado === st).length}</span>`).join(' ')}
          </div>
          <button type="button" class="btn btn-sm btn-primary" data-action="new-ep" data-api-id="${esc(api.id)}">${icn('add')}Agregar endpoint / feature</button>
        </div>
        ${api.endpointsFeatures.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Método</th><th>Ruta / nombre</th><th>Responsable</th><th>Fecha estimada</th><th>Estado</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <p class="hint">${icn('info')}Hacé clic en el estado para pasar al siguiente (Pendiente → En Progreso → Completado → Bloqueado). Los cambios se guardan como borrador local hasta que los publiques.</p>`
        : '<div class="empty">Esta API todavía no tiene endpoints ni features cargados.</div>'}
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn btn-danger-ghost" data-action="delete-api" data-api-id="${esc(api.id)}">Eliminar API</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary" data-action="edit-api" data-api-id="${esc(api.id)}">${icn('edit')}Editar API</button>
        <button type="button" class="btn btn-primary" data-action="close-modal">Cerrar</button>
      </footer>`;
  }

  function cycleEndpoint(apiId, epId) {
    const api = findApi(apiId);
    const ep = api && api.endpointsFeatures.find((e) => e.id === epId);
    if (!ep) return;
    ep.estado = ESTADOS_EP[(ESTADOS_EP.indexOf(ep.estado) + 1) % ESTADOS_EP.length];
    commit();
    toast(`"${ep.rutaONombre}" → ${ep.estado}`, 'success');
  }

  // ---------------------------------------------------------------------------
  // Formularios: API
  // ---------------------------------------------------------------------------
  function setOptions(select, values) {
    select.innerHTML = values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  }

  function openApiForm(apiId) {
    const form = $('#form-api');
    form.reset();
    $('#form-api-error').textContent = '';
    const api = apiId ? findApi(apiId) : null;
    $('#form-api-title').textContent = api ? `Editar API · ${api.nombre}` : 'Nueva API';
    form.elements.originalId.value = api ? api.id : '';
    form.elements.id.value = api ? api.id : '';
    form.elements.nombre.value = api ? api.nombre : '';
    form.elements.contexto.value = api ? api.contexto : '';
    form.elements.responsableNombre.value = api ? api.responsable.nombre : '';
    form.elements.responsableRol.value = api ? api.responsable.rol : '';
    form.elements.desarrolloAfectado.value = api ? api.desarrolloAfectado.join(', ') : '';
    form.elements.estadoGeneral.value = api ? api.estadoGeneral : 'Planificada';
    form.elements.fechaEstimadaEntrega.value = api ? api.fechaEstimadaEntrega : '';
    $('#modal-api').showModal();
    (api ? form.elements.nombre : form.elements.id).focus();
  }

  function submitApiForm(ev) {
    ev.preventDefault();
    const el = ev.target.elements;
    const errBox = $('#form-api-error');
    const originalId = el.originalId.value;
    const id = str(el.id.value);
    const nombre = str(el.nombre.value);
    const respNombre = str(el.responsableNombre.value);
    const fecha = str(el.fechaEstimadaEntrega.value);

    let error = '';
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) error = 'El ID es obligatorio y solo admite minúsculas, números, puntos, guiones y guiones bajos.';
    else if (id !== originalId && findApi(id)) error = `Ya existe una API con el ID "${id}".`;
    else if (!nombre) error = 'El nombre es obligatorio.';
    else if (!respNombre) error = 'El responsable es obligatorio.';
    else if (!ESTADOS_API.includes(el.estadoGeneral.value)) error = 'Seleccioná un estado válido.';
    else if (fecha && !parseDate(fecha)) error = 'La fecha estimada no es válida (YYYY-MM-DD).';
    if (error) { errBox.textContent = error; return; }

    const existing = originalId ? findApi(originalId) : null;
    const api = {
      id,
      nombre,
      contexto: str(el.contexto.value),
      responsable: { nombre: respNombre, rol: str(el.responsableRol.value) },
      desarrolloAfectado: uniq(el.desarrolloAfectado.value.split(',').map(str).filter(Boolean)),
      estadoGeneral: el.estadoGeneral.value,
      fechaEstimadaEntrega: fecha,
      endpointsFeatures: existing ? existing.endpointsFeatures : [],
    };
    if (existing) {
      state.data.apis[state.data.apis.indexOf(existing)] = api;
      if (state.detailApiId === originalId) state.detailApiId = id;
    } else {
      state.data.apis.push(api);
    }
    $('#modal-api').close();
    commit();
    toast(existing ? `API "${nombre}" actualizada (borrador local).` : `API "${nombre}" creada (borrador local).`, 'success');
  }

  async function deleteApi(apiId) {
    const api = findApi(apiId);
    if (!api) return;
    const ok = await confirmDialog('Eliminar API',
      `¿Eliminar la API "${api.nombre}" y sus ${api.endpointsFeatures.length} endpoints/features? El cambio queda en el borrador local hasta que lo publiques.`,
      'Eliminar');
    if (!ok) return;
    state.data.apis = state.data.apis.filter((a) => a.id !== apiId);
    if (state.detailApiId === apiId) {
      state.detailApiId = null;
      $('#modal-detail').close();
    }
    commit();
    toast(`API "${api.nombre}" eliminada.`, 'success');
  }

  // ---------------------------------------------------------------------------
  // Formularios: endpoint / feature
  // ---------------------------------------------------------------------------
  function suggestEndpointId(api) {
    const eps = api.endpointsFeatures;
    const last = eps[eps.length - 1];
    let prefix = `${api.id}-ep-`;
    let width = 2;
    let n = eps.length + 1;
    const m = last ? String(last.id).match(/^(.*?)(\d+)$/) : null;
    if (m) {
      prefix = m[1];
      width = m[2].length;
      n = parseInt(m[2], 10) + 1;
    }
    const ids = new Set(eps.map((e) => e.id));
    let id;
    do {
      id = prefix + String(n).padStart(width, '0');
      n += 1;
    } while (ids.has(id));
    return id;
  }

  function openEndpointForm(apiId, epId) {
    const api = findApi(apiId);
    if (!api) return;
    const ep = epId ? api.endpointsFeatures.find((e) => e.id === epId) : null;
    const form = $('#form-endpoint');
    form.reset();
    $('#form-endpoint-error').textContent = '';
    $('#form-endpoint-title').textContent = ep ? `Editar endpoint / feature · ${api.nombre}` : `Nuevo endpoint / feature · ${api.nombre}`;
    form.elements.apiId.value = api.id;
    form.elements.originalId.value = ep ? ep.id : '';
    form.elements.id.value = ep ? ep.id : suggestEndpointId(api);
    form.elements.metodo.value = ep ? ep.metodo : 'GET';
    form.elements.rutaONombre.value = ep ? ep.rutaONombre : '';
    form.elements.descripcion.value = ep ? ep.descripcion : '';
    form.elements.estado.value = ep ? ep.estado : 'Pendiente';
    form.elements.fechaEstimada.value = ep ? ep.fechaEstimada : (api.fechaEstimadaEntrega || '');
    form.elements.responsableFeature.value = ep ? ep.responsableFeature : '';
    form.elements.responsableFeature.placeholder = `Vacío = hereda "${api.responsable.nombre || 'responsable de la API'}"`;
    $('#modal-endpoint').showModal();
    form.elements.rutaONombre.focus();
  }

  function submitEndpointForm(ev) {
    ev.preventDefault();
    const el = ev.target.elements;
    const errBox = $('#form-endpoint-error');
    const api = findApi(el.apiId.value);
    if (!api) { errBox.textContent = 'La API ya no existe.'; return; }
    const originalId = el.originalId.value;
    const id = str(el.id.value);
    const ruta = str(el.rutaONombre.value);
    const fecha = str(el.fechaEstimada.value);

    let error = '';
    if (!id) error = 'El ID es obligatorio.';
    else if (id !== originalId && api.endpointsFeatures.some((e) => e.id === id)) error = `Ya existe un endpoint con el ID "${id}" en esta API.`;
    else if (!METODOS.includes(el.metodo.value)) error = 'Seleccioná un método válido.';
    else if (!ruta) error = 'La ruta o nombre es obligatoria.';
    else if (!ESTADOS_EP.includes(el.estado.value)) error = 'Seleccioná un estado válido.';
    else if (fecha && !parseDate(fecha)) error = 'La fecha estimada no es válida (YYYY-MM-DD).';
    if (error) { errBox.textContent = error; return; }

    const ep = {
      id,
      metodo: el.metodo.value,
      rutaONombre: ruta,
      descripcion: str(el.descripcion.value),
      estado: el.estado.value,
      responsableFeature: str(el.responsableFeature.value),
      fechaEstimada: fecha,
    };
    const idx = originalId ? api.endpointsFeatures.findIndex((e) => e.id === originalId) : -1;
    if (idx >= 0) api.endpointsFeatures[idx] = ep;
    else api.endpointsFeatures.push(ep);
    $('#modal-endpoint').close();
    commit();
    toast(idx >= 0 ? 'Endpoint / feature actualizado.' : 'Endpoint / feature agregado.', 'success');
  }

  async function deleteEndpoint(apiId, epId) {
    const api = findApi(apiId);
    const ep = api && api.endpointsFeatures.find((e) => e.id === epId);
    if (!ep) return;
    const ok = await confirmDialog('Eliminar endpoint / feature', `¿Eliminar "${ep.metodo} ${ep.rutaONombre}" de "${api.nombre}"?`, 'Eliminar');
    if (!ok) return;
    api.endpointsFeatures = api.endpointsFeatures.filter((e) => e.id !== epId);
    commit();
    toast('Endpoint / feature eliminado.', 'success');
  }

  // ---------------------------------------------------------------------------
  // Diálogo de confirmación y notificaciones
  // ---------------------------------------------------------------------------
  function confirmDialog(title, message, okLabel, danger) {
    const dlg = $('#modal-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const okBtn = $('#confirm-ok');
    okBtn.textContent = okLabel || 'Confirmar';
    okBtn.className = `btn ${danger === false ? 'btn-primary' : 'btn-danger'}`;
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = `toast toast-${type || 'info'}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 10000 : 5000);
    el.addEventListener('click', () => el.remove());
  }

  // ---------------------------------------------------------------------------
  // Configuración GitHub (UI)
  // ---------------------------------------------------------------------------
  function openSettings() {
    const form = $('#form-settings');
    const cfg = getConfig();
    $('#form-settings-error').textContent = '';
    form.elements.owner.value = cfg.owner;
    form.elements.repo.value = cfg.repo;
    form.elements.branch.value = cfg.branch;
    form.elements.path.value = cfg.path;
    form.elements.token.value = getToken();
    const det = detectRepo();
    $('#gh-detected').textContent = det
      ? `Detectado desde la URL de GitHub Pages: ${det.owner}/${det.repo}.`
      : 'No se pudo autodetectar el repositorio (el sitio no se está sirviendo desde *.github.io). Completá los datos manualmente.';
    $('#modal-settings').showModal();
  }

  function readSettingsForm() {
    const el = $('#form-settings').elements;
    const cfg = {
      owner: str(el.owner.value),
      repo: str(el.repo.value),
      branch: str(el.branch.value) || 'main',
      path: str(el.path.value).replace(/^\/+/, '') || DATA_URL,
    };
    const token = str(el.token.value);
    let error = '';
    if (!/^[A-Za-z0-9-]+$/.test(cfg.owner)) error = 'Owner inválido.';
    else if (!/^[A-Za-z0-9._-]+$/.test(cfg.repo)) error = 'Nombre de repositorio inválido.';
    else if (/\s|\.\.|^\/|\/$/.test(cfg.branch)) error = 'Nombre de rama inválido.';
    else if (/\.\./.test(cfg.path) || !/\.json$/i.test(cfg.path)) error = 'La ruta debe apuntar a un archivo .json dentro del repositorio.';
    else if (token && /\s/.test(token)) error = 'El token no puede contener espacios.';
    return { cfg, token, error };
  }

  function submitSettings(ev) {
    ev.preventDefault();
    const { cfg, token, error } = readSettingsForm();
    if (error) { $('#form-settings-error').textContent = error; return; }
    lsSet(LS.config, JSON.stringify(cfg));
    if (token) lsSet(LS.token, token);
    else lsDel(LS.token);
    $('#modal-settings').close();
    toast(token ? 'Configuración guardada. Ya podés usar "Guardar en Repositorio".' : 'Configuración guardada sin token: solo modo local / exportación.', 'success');
  }

  async function runTestConnection(btn) {
    const { cfg, token, error } = readSettingsForm();
    const errBox = $('#form-settings-error');
    if (error) { errBox.textContent = error; return; }
    if (!token) { errBox.textContent = 'Ingresá un token para probar la conexión.'; return; }
    errBox.textContent = '';
    btn.disabled = true;
    try {
      const r = await testConnection(cfg, token);
      const lines = [`Conexión OK con ${r.repo.full_name} (rama ${cfg.branch}).`];
      lines.push(r.fileExists ? `Archivo ${cfg.path} encontrado.` : `El archivo ${cfg.path} no existe: se creará al guardar.`);
      if (r.canPush === false) lines.push('⚠ El token NO tiene permiso de escritura en este repositorio.');
      toast(lines.join('\n'), r.canPush === false ? 'warning' : 'success');
    } catch (e) {
      errBox.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Guardar en repositorio (commit vía GitHub API)
  // ---------------------------------------------------------------------------
  function setSaving(on) {
    state.saving = on;
    $$('[data-action="save-repo"]').forEach((b) => {
      b.disabled = on;
      b.setAttribute('aria-busy', on ? 'true' : 'false');
    });
  }

  async function saveToRepo() {
    if (state.saving) return;
    const cfg = getConfig();
    const token = getToken();
    if (!isConfigured(cfg, token)) {
      toast('Para guardar directamente configurá owner, repositorio, rama y un token de GitHub.\nAlternativa: usá "Exportar JSON" y subilo por commit o Pull Request.', 'warning');
      openSettings();
      return;
    }
    setSaving(true);
    toast(`Publicando cambios en ${cfg.owner}/${cfg.repo}@${cfg.branch}…`, 'info');
    try {
      let current = await ghGetFile(cfg, token);
      if (current && state.remoteSha && current.sha !== state.remoteSha) {
        const ok = await confirmDialog('Conflicto de versiones',
          `El archivo ${cfg.path} fue modificado en el repositorio después de que cargaste los datos. Si continuás, tu versión reemplazará esos cambios remotos.\n\nAlternativa segura: cancelá, exportá tu JSON, usá "Recargar desde repositorio" y volvé a aplicar tus cambios.`,
          'Sobrescribir');
        if (!ok) {
          toast('Publicación cancelada. Tus cambios siguen en el borrador local.', 'info');
          return;
        }
      }
      const content = serializeData();
      const message = `chore(apis): actualizar seguimiento de APIs desde el dashboard (${state.data.apis.length} APIs)`;
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await ghPutFile(cfg, token, content, current ? current.sha : null, message);
          break;
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && attempt === 0) {
            current = await ghGetFile(cfg, token);
            const ok = await confirmDialog('Conflicto al guardar',
              `${e.message}\n\n¿Querés sobrescribir el archivo remoto con tu versión actual?`, 'Sobrescribir');
            if (!ok) {
              toast('Publicación cancelada. Tus cambios siguen en el borrador local.', 'info');
              return;
            }
            continue;
          }
          throw e;
        }
      }
      state.remoteSha = result && result.content ? result.content.sha : null;
      clearDraft();
      state.source = `GitHub API · ${cfg.owner}/${cfg.repo}@${cfg.branch}`;
      renderAll();
      const shortSha = result && result.commit && result.commit.sha ? result.commit.sha.slice(0, 7) : '';
      toast(`✔ Cambios publicados${shortSha ? ` (commit ${shortSha})` : ''}.\nGitHub Pages se actualizará en 1–2 minutos.`, 'success');
    } catch (e) {
      console.error(e);
      toast(`No se pudo guardar en el repositorio.\n${e.message}\nTus cambios siguen en el borrador local.`, 'error');
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Exportar / importar / recargar
  // ---------------------------------------------------------------------------
  function exportJson() {
    const blob = new Blob([serializeData()], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `apis-aca-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('JSON exportado. Reemplazá data/apis.json en el repositorio con este archivo (commit o Pull Request).', 'success');
  }

  async function importJson(file) {
    if (!file) return;
    try {
      const text = await file.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error(`El archivo no es JSON válido: ${e.message}`);
      }
      const data = normalizeData(json);
      const ok = await confirmDialog('Importar JSON',
        `Se reemplazarán las ${state.data.apis.length} APIs actuales por las ${data.apis.length} APIs del archivo "${file.name}". Quedará como borrador local hasta que lo publiques.`,
        'Importar', false);
      if (!ok) return;
      state.data = data;
      state.loadError = null;
      if (!state.source || state.source === 'Sin datos') state.source = `Importado · ${file.name}`;
      commit();
      toast(`Se importaron ${data.apis.length} APIs desde "${file.name}".`, 'success');
    } catch (e) {
      toast(`No se pudo importar el archivo.\n${e.message}`, 'error');
    }
  }

  async function reloadRemote(skipConfirm) {
    if (state.hasDraft && !skipConfirm) {
      const ok = await confirmDialog('Recargar desde repositorio',
        'Tenés cambios locales sin publicar. Si recargás, se descartará el borrador. ¿Continuar? (Podés exportar el JSON antes para conservarlos.)',
        'Descartar y recargar');
      if (!ok) return;
    }
    clearDraft();
    try {
      await loadRemote();
      toast('Datos recargados desde el repositorio.', 'success');
    } catch (e) {
      state.loadError = e.message;
      state.source = 'Sin datos';
      toast(e.message, 'error');
    }
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------
  function closeMenu() {
    const menu = $('#more-menu');
    menu.classList.remove('open');
    const btn = $('[data-action="toggle-menu"]');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function handleAction(action, el) {
    const apiId = el.dataset.apiId;
    const epId = el.dataset.epId;
    switch (action) {
      case 'toggle-menu': {
        const menu = $('#more-menu');
        const open = !menu.classList.contains('open');
        menu.classList.toggle('open', open);
        el.setAttribute('aria-expanded', String(open));
        return;
      }
      case 'new-api': openApiForm(null); break;
      case 'edit-api': openApiForm(apiId); break;
      case 'delete-api': deleteApi(apiId); break;
      case 'open-detail': openDetail(apiId); break;
      case 'new-ep': openEndpointForm(apiId, null); break;
      case 'edit-ep': openEndpointForm(apiId, epId); break;
      case 'delete-ep': deleteEndpoint(apiId, epId); break;
      case 'cycle-ep': cycleEndpoint(apiId, epId); break;
      case 'save-repo': saveToRepo(); break;
      case 'export-json': exportJson(); break;
      case 'import-json': $('#import-file').click(); break;
      case 'reload-remote': reloadRemote(false); break;
      case 'discard-draft': reloadRemote(false); break;
      case 'open-settings': openSettings(); break;
      case 'test-connection': runTestConnection(el); break;
      case 'forget-token':
        lsDel(LS.token);
        $('#form-settings').elements.token.value = '';
        toast('Token eliminado de este navegador.', 'success');
        break;
      case 'clear-filters':
        ['#f-search', '#f-responsable', '#f-desarrollo', '#f-estado', '#f-desde', '#f-hasta'].forEach((s) => { $(s).value = ''; });
        renderAll();
        break;
      case 'set-view':
        state.view = el.dataset.view === 'table' ? 'table' : 'cards';
        lsSet(LS.view, state.view);
        renderAll();
        break;
      case 'close-modal': {
        const dlg = el.closest('dialog');
        if (dlg) dlg.close();
        break;
      }
      default:
        break;
    }
    closeMenu();
  }

  function bindEvents() {
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-action]');
      if (!el) {
        if (!ev.target.closest('.dropdown')) closeMenu();
        return;
      }
      handleAction(el.dataset.action, el);
    });

    // Cerrar modales al hacer clic en el fondo.
    $$('dialog').forEach((dlg) => {
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg && dlg.id !== 'modal-confirm') dlg.close();
      });
    });
    $('#modal-detail').addEventListener('close', () => { state.detailApiId = null; });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeMenu();
    });

    ['#f-search', '#f-responsable', '#f-desarrollo', '#f-estado', '#f-desde', '#f-hasta'].forEach((s) => {
      $(s).addEventListener('input', renderAll);
    });

    $('#form-api').addEventListener('submit', submitApiForm);
    $('#form-endpoint').addEventListener('submit', submitEndpointForm);
    $('#form-settings').addEventListener('submit', submitSettings);
    $('#import-file').addEventListener('change', (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      importJson(file);
    });

    // Sincroniza el borrador si se edita en otra pestaña.
    window.addEventListener('storage', (ev) => {
      if (ev.key !== LS.draft) return;
      const draft = readDraft();
      if (draft) {
        try {
          state.data = normalizeData(draft.data);
          state.remoteSha = draft.baseSha || null;
          state.hasDraft = true;
          state.draftSavedAt = draft.savedAt || null;
          renderAll();
        } catch (e) { /* ignorado */ }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Inicio
  // ---------------------------------------------------------------------------
  async function init() {
    setOptions($('#f-estado'), ['', ...ESTADOS_API]);
    $('#f-estado').options[0].textContent = 'Todos';
    setOptions($('#api-estado'), ESTADOS_API);
    setOptions($('#ep-metodo'), METODOS);
    setOptions($('#ep-estado'), ESTADOS_EP);
    state.view = lsGet(LS.view) === 'table' ? 'table' : 'cards';
    bindEvents();
    await loadInitial();
    renderAll();
  }

  // Expuesto solo para pruebas manuales desde la consola.
  window.ACA_APIS = { state, normalizeData, utf8ToBase64, base64ToUtf8, serializeData };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
