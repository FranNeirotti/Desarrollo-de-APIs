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
  const ESTADOS_EP = ['Pendiente', 'En Progreso', 'En Test', 'Completado', 'Bloqueado'];
  const PRIORIDADES = ['Alta', 'Media', 'Baja'];
  const PRIORIDAD_DEFAULT = 'Media';
  const SORT_MODES = ['manual', 'prioridad'];
  const EP_FILTER_PREFIX = 'ep:';
  const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'EVENT/ASYNC', 'FEATURE'];
  const DIAS_PROXIMA = 14;
  const DATA_URL = 'data/apis.json';
  const GH_API = 'https://api.github.com';
  const LS = {
    draft: 'aca-apis:draft',
    config: 'aca-apis:github-config',
    token: 'aca-apis:github-token',
    view: 'aca-apis:view',
    sort: 'aca-apis:sort',
  };

  const state = {
    data: { version: 1, actualizado: null, apis: [] },
    source: '',
    hasDraft: false,
    draftSavedAt: null,
    remoteSha: null,
    view: 'cards',
    sort: 'manual',
    detailApiId: null,
    saving: false,
    loadError: null,
    filterOpts: { responsable: [], desarrollo: [] },
    pop: null,
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
  // Sin prioridad (datos anteriores) = Media. El orden manual es el orden del arreglo en el JSON.
  function normalizePrioridad(p) {
    const v = str(p).toLowerCase();
    return PRIORIDADES.find((x) => x.toLowerCase() === v) || PRIORIDAD_DEFAULT;
  }

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
      prioridad: normalizePrioridad(e.prioridad),
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
      prioridad: normalizePrioridad(a.prioridad),
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

  // Vista ordenada: "manual" respeta el orden del arreglo; "prioridad" agrupa Alta > Media > Baja
  // manteniendo el orden manual dentro de cada nivel (sort estable).
  function sortItems(list) {
    if (state.sort !== 'prioridad') return list.slice();
    const rank = (x) => PRIORIDADES.indexOf(x.prioridad);
    return list.slice().sort((a, b) => rank(a) - rank(b));
  }

  function moveInList(list, fromId, toId, after) {
    const from = list.findIndex((x) => x.id === fromId);
    if (from < 0 || fromId === toId) return false;
    const [item] = list.splice(from, 1);
    let to = list.findIndex((x) => x.id === toId);
    if (to < 0) { list.splice(from, 0, item); return false; }
    if (after) to += 1;
    list.splice(to, 0, item);
    return to !== from;
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
      testing: count('En Test'),
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
      api.estadoGeneral, api.prioridad, api.desarrolloAfectado.join(' '),
    ];
    api.endpointsFeatures.forEach((e) => {
      parts.push(e.id, e.metodo, e.rutaONombre, e.descripcion, e.responsableFeature, e.estado);
    });
    return fold(parts.join(' \u0001 '));
  }

  function matchesFilters(api, f) {
    if (f.responsable && !apiResponsables(api).includes(f.responsable)) return false;
    if (f.desarrollo && !api.desarrolloAfectado.includes(f.desarrollo)) return false;
    if (f.estado) {
      if (f.estado.startsWith(EP_FILTER_PREFIX)) {
        const epEstado = f.estado.slice(EP_FILTER_PREFIX.length);
        if (!api.endpointsFeatures.some((e) => e.estado === epEstado)) return false;
      } else if (api.estadoGeneral !== f.estado) {
        return false;
      }
    }
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
    state.filterOpts = {
      responsable: sortEs(uniq(responsables.filter(Boolean))),
      desarrollo: sortEs(uniq(desarrollos.filter(Boolean))),
    };
    fillDatalist($('#dl-responsables'), responsables);
    fillDatalist($('#dl-desarrollos'), desarrollos);
  }

  // ---------------------------------------------------------------------------
  // Fragmentos de UI
  // ---------------------------------------------------------------------------
  const icn = (name, cls) => `<span class="ms${cls ? ` ${cls}` : ''}" aria-hidden="true">${name}</span>`;
  const badge = (estado) => `<span class="badge badge-${slug(estado)}">${esc(estado)}</span>`;
  const methodTag = (m) => `<span class="method method-${slug(m)}">${esc(m)}</span>`;

  function prioSelect(prioridad, label, apiId, epId) {
    return `<select class="prio-select prio-${slug(prioridad)}" data-prio data-api-id="${esc(apiId)}"${epId ? ` data-ep-id="${esc(epId)}"` : ''}
      aria-label="Prioridad de ${esc(label)}" title="Prioridad">
      ${PRIORIDADES.map((p) => `<option value="${esc(p)}"${p === prioridad ? ' selected' : ''}>${esc(p)}</option>`).join('')}
    </select>`;
  }

  function dragHandle(label, apiId, epId) {
    if (state.sort !== 'manual') return '';
    return `<button type="button" class="drag-handle" data-drag-handle data-api-id="${esc(apiId)}"${epId ? ` data-ep-id="${esc(epId)}"` : ''}
      title="Arrastrá para reordenar (o usá las flechas ↑ ↓)" aria-label="Reordenar ${esc(label)}. Usá las flechas arriba y abajo para moverlo."
      aria-roledescription="control de orden">${icn('drag_indicator')}</button>`;
  }

  function sortToggleHtml() {
    const btn = (mode, icon, label, title) => `<button type="button" class="btn btn-sm btn-ghost${state.sort === mode ? ' is-active' : ''}"
      data-action="set-sort" data-sort-mode="${mode}" aria-pressed="${state.sort === mode}" title="${esc(title)}">${icn(icon)}${label}</button>`;
    return `<div class="view-toggle sort-toggle" role="group" aria-label="Ordenar por">
      <span class="sort-toggle-label">Ordenar</span>
      ${btn('manual', 'drag_indicator', 'Manual', 'Orden manual: arrastrá para reordenar')}
      ${btn('prioridad', 'sort', 'Prioridad', 'Alta → Media → Baja, respetando el orden manual dentro de cada nivel')}
    </div>`;
  }

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
    let epTest = 0;
    let epBlock = 0;
    apis.forEach((a) => {
      const s = apiStats(a);
      epTotal += s.total;
      epDone += s.done;
      epProg += s.inProgress;
      epTest += s.testing;
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
        <div class="kpi-sub">${epTotal - epDone} pendientes de ${epTotal} · ${epProg} en progreso · ${epTest} en test · ${epBlock} bloqueados</div>
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
      <article class="api-card" data-sort-item data-api-id="${esc(api.id)}">
        <div class="api-card-head">
          ${dragHandle(api.nombre, api.id)}
          <div class="api-card-title">
            <h3>${esc(api.nombre)}</h3>
            <div class="api-id">${esc(api.id)}</div>
          </div>
          ${badge(api.estadoGeneral)}
        </div>
        <p class="api-context" title="${esc(api.contexto)}">${esc(api.contexto || 'Sin contexto cargado.')}</p>
        <dl class="meta">
          <dt>Responsable</dt><dd>${responsableText(api.responsable)}</dd>
          <dt>Entrega</dt><dd>${dateChip(api.fechaEstimadaEntrega, api.estadoGeneral === 'En Producción')}</dd>
          <dt>Prioridad</dt><dd>${prioSelect(api.prioridad, api.nombre, api.id)}</dd>
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
              ${state.sort === 'manual' ? '<th class="cell-handle"><span class="sr-only">Orden</span></th>' : ''}
              <th>API</th><th>Responsable</th><th>Estado</th><th>Prioridad</th><th>Avance</th>
              <th>Endpoints</th><th>Entrega</th><th>Desarrollo afectado</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${apis.map((api) => {
              const s = apiStats(api);
              return `
                <tr data-sort-item data-api-id="${esc(api.id)}">
                  ${state.sort === 'manual' ? `<td class="cell-handle">${dragHandle(api.nombre, api.id)}</td>` : ''}
                  <td><div class="cell-name">${esc(api.nombre)}</div><div class="api-id">${esc(api.id)}</div></td>
                  <td>${responsableText(api.responsable)}</td>
                  <td>${badge(api.estadoGeneral)}</td>
                  <td>${prioSelect(api.prioridad, api.nombre, api.id)}</td>
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
    $('#list-sort').innerHTML = sortToggleHtml();

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
    const apis = sortItems(state.data.apis.filter((a) => matchesFilters(a, f)));
    const alerts = collectAlerts(apis);
    renderKpis(apis, alerts);
    renderAlerts(alerts);
    renderList(apis);
    renderStatus();
    syncFilterUi();
    if (state.detailApiId && $('#modal-detail').open) renderDetail();
  }

  // ---------------------------------------------------------------------------
  // Barra de filtros (patrón Giro/BackOffice: botones de texto + popovers + chips)
  // ---------------------------------------------------------------------------
  const FILTER_DEFS = {
    responsable: { label: 'Responsable', all: 'Todos los responsables', search: 'Buscar responsable o rol…' },
    desarrollo: { label: 'Desarrollo afectado', all: 'Todos los desarrollos', search: 'Buscar desarrollo o sistema…' },
    estado: { label: 'Estado', all: 'Todos los estados' },
  };
  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const DIAS_SEMANA = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];

  function toISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function fmtShort(s) {
    const d = parseDate(s);
    return d ? d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  }

  // ---------------------------------------------------------------------------
  // Campo de fecha (DS Date picker, variante "Input de formulario": input + calendario)
  // Muestra dd/mm/aaaa y guarda YYYY-MM-DD en el input oculto del formulario.
  // ---------------------------------------------------------------------------
  const MESES_LARGOS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const DATE_ERROR = 'Fecha inválida. Usá el formato dd/mm/aaaa.';
  const dp = { field: null, month: null, focus: '', escAt: 0 };

  function fmtDMY(iso) {
    const d = parseDate(iso);
    return d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '';
  }

  // '' si está vacío, null si es inválido, YYYY-MM-DD si es válido. Acepta dd/mm/aaaa, d-m-aaaa, ddmmaaaa y aaaa-mm-dd.
  function parseDMY(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    let y; let mo; let d;
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) [, y, mo, d] = m;
    else {
      m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/) || v.match(/^(\d{2})(\d{2})(\d{4})$/);
      if (!m) return null;
      [, d, mo, y] = m;
    }
    [y, mo, d] = [Number(y), Number(mo), Number(d)];
    const dt = new Date(y, mo - 1, d);
    if (y < 1900 || y > 2100 || dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return toISO(dt);
  }

  // Inserta las barras mientras se tipea (solo al escribir al final, sin pisar borrados).
  function maskDateInput(input, ev) {
    if (ev && ev.inputType && !ev.inputType.startsWith('insert')) return;
    const v = input.value;
    if (!/^[\d/]*$/.test(v) || input.selectionStart !== v.length) return;
    const dg = v.replace(/\D/g, '').slice(0, 8);
    let out = dg.slice(0, 2);
    if (dg.length > 2 || (dg.length === 2 && v.length >= 2)) out += `/${dg.slice(2, 4)}`;
    if (dg.length > 4 || (dg.length === 4 && v.length >= 5)) out += `/${dg.slice(4)}`;
    if (out !== v) input.value = out;
  }

  const dateParts = (field) => ({
    text: $('.date-input', field),
    hidden: $('input[type="hidden"]', field),
    clear: $('[data-date-clear]', field),
    open: $('[data-date-open]', field),
  });

  function setDateError(field, msg) {
    const { text } = dateParts(field);
    const box = document.getElementById(text.getAttribute('aria-describedby'));
    if (msg) text.setAttribute('aria-invalid', 'true');
    else text.removeAttribute('aria-invalid');
    if (box) {
      box.textContent = msg;
      box.hidden = !msg;
    }
  }

  function setDateField(field, iso) {
    const { text, hidden, clear } = dateParts(field);
    const v = parseDate(iso) ? iso : '';
    hidden.value = v;
    text.value = fmtDMY(v);
    clear.hidden = !v;
    setDateError(field, '');
  }

  // Pasa el texto tipeado al valor del formulario. Devuelve false si la fecha es inválida.
  function commitDateField(field) {
    const { text, hidden, clear } = dateParts(field);
    const iso = parseDMY(text.value);
    if (iso === null) {
      hidden.value = '';
      clear.hidden = !text.value;
      setDateError(field, DATE_ERROR);
      return false;
    }
    setDateField(field, iso);
    return true;
  }

  function datePop() {
    let pop = $('#date-pop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'date-pop';
      pop.className = 'date-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'Elegir fecha');
      pop.hidden = true;
      bindDatePop(pop);
    }
    return pop;
  }

  function openDatePop(field) {
    closeDatePop(false);
    commitDateField(field);
    const base = parseDate(dateParts(field).hidden.value) || today();
    dp.field = field;
    dp.month = new Date(base.getFullYear(), base.getMonth(), 1);
    dp.focus = toISO(base);
    const pop = datePop();
    (field.closest('dialog') || document.body).appendChild(pop);
    pop.hidden = false;
    field.classList.add('is-open');
    dateParts(field).open.setAttribute('aria-expanded', 'true');
    renderDateCal();
    positionDatePop();
    focusDateDay();
  }

  function closeDatePop(returnFocus) {
    const field = dp.field;
    if (!field) return;
    dp.field = null;
    datePop().hidden = true;
    field.classList.remove('is-open');
    dateParts(field).open.setAttribute('aria-expanded', 'false');
    if (returnFocus) dateParts(field).text.focus();
  }

  function renderDateCal() {
    const m = dp.month;
    const sel = dateParts(dp.field).hidden.value;
    const todayIso = toISO(today());
    const monthKey = toISO(m).slice(0, 7);
    if (dp.focus.slice(0, 7) !== monthKey) dp.focus = sel.slice(0, 7) === monthKey ? sel : toISO(m);
    const offset = (m.getDay() + 6) % 7;
    let cells = '';
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(m.getFullYear(), m.getMonth(), 1 - offset + i);
      const iso = toISO(d);
      const cls = ['dcal-day'];
      if (iso.slice(0, 7) !== monthKey) cls.push('is-out');
      if (iso === todayIso) cls.push('is-today');
      if (iso === sel) cls.push('is-selected');
      const label = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      cells += `<button type="button" class="${cls.join(' ')}" data-dcal-day="${iso}" aria-label="${esc(label)}${iso === todayIso ? ' (hoy)' : ''}"
        aria-pressed="${iso === sel}"${iso === todayIso ? ' aria-current="date"' : ''} tabindex="${iso === dp.focus ? 0 : -1}">${d.getDate()}</button>`;
    }
    const title = `${MESES_LARGOS[m.getMonth()]} ${m.getFullYear()}`;
    datePop().innerHTML = `
      <div class="dcal-head">
        <span class="dcal-title" aria-live="polite">${title}</span>
        <span class="dcal-nav">
          <button type="button" class="dcal-btn" data-dcal-nav="-1" aria-label="Mes anterior">${icn('chevron_left')}</button>
          <button type="button" class="dcal-btn" data-dcal-nav="1" aria-label="Mes siguiente">${icn('chevron_right')}</button>
        </span>
      </div>
      <div class="dcal-grid" role="group" aria-label="${title}">
        ${DIAS_SEMANA.map((d) => `<span class="dcal-wd" aria-hidden="true">${d}</span>`).join('')}
        ${cells}
      </div>
      <div class="dcal-foot">
        <button type="button" class="pop-link" data-dcal-today>Hoy</button>
        <button type="button" class="pop-link" data-dcal-clear${sel ? '' : ' disabled'}>Borrar fecha</button>
      </div>`;
  }

  function focusDateDay() {
    const btn = $(`#date-pop [data-dcal-day="${dp.focus}"]`);
    if (btn) btn.focus();
  }

  function positionDatePop() {
    if (!dp.field) return;
    const pop = datePop();
    const r = dp.field.getBoundingClientRect();
    const m = 8;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - m && r.top - 4 - h >= m) top = r.top - 4 - h;
    top = Math.max(m, Math.min(top, window.innerHeight - h - m));
    const left = Math.max(m, Math.min(r.left, window.innerWidth - w - m));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }

  function pickDate(iso) {
    const field = dp.field;
    setDateField(field, iso);
    closeDatePop(true);
    announce(iso ? `Fecha seleccionada: ${fmtDMY(iso)}` : 'Fecha borrada');
  }

  function moveDateFocus(next) {
    dp.focus = toISO(next);
    dp.month = new Date(next.getFullYear(), next.getMonth(), 1);
    renderDateCal();
    focusDateDay();
  }

  function bindDatePop(pop) {
    pop.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!dp.field) return;
      const day = ev.target.closest('[data-dcal-day]');
      if (day) { pickDate(day.dataset.dcalDay); return; }
      const nav = ev.target.closest('[data-dcal-nav]');
      if (nav) {
        const n = Number(nav.dataset.dcalNav);
        dp.month = new Date(dp.month.getFullYear(), dp.month.getMonth() + n, 1);
        renderDateCal();
        const again = $(`#date-pop [data-dcal-nav="${n}"]`);
        if (again) again.focus();
        return;
      }
      if (ev.target.closest('[data-dcal-today]')) pickDate(toISO(today()));
      else if (ev.target.closest('[data-dcal-clear]')) pickDate('');
    });
    pop.addEventListener('keydown', (ev) => {
      if (!dp.field) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        dp.escAt = Date.now();
        closeDatePop(true);
        return;
      }
      const day = ev.target.closest('[data-dcal-day]');
      if (!day) return;
      const d = parseDate(day.dataset.dcalDay);
      const dow = (d.getDay() + 6) % 7;
      const moves = {
        ArrowLeft: () => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1),
        ArrowRight: () => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1),
        ArrowUp: () => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7),
        ArrowDown: () => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7),
        Home: () => new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow),
        End: () => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6 - dow),
        PageUp: () => new Date(d.getFullYear(), d.getMonth() - 1, Math.min(d.getDate(), 28)),
        PageDown: () => new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), 28)),
      };
      if (moves[ev.key]) {
        ev.preventDefault();
        moveDateFocus(moves[ev.key]());
      }
    });
    pop.addEventListener('focusout', (ev) => {
      const to = ev.relatedTarget;
      if (dp.field && to && !pop.contains(to) && !dp.field.contains(to)) closeDatePop(false);
    });
  }

  function bindDateFields() {
    document.addEventListener('click', (ev) => {
      const field = ev.target.closest('.date-field');
      if (dp.field && !ev.target.closest('#date-pop') && field !== dp.field) closeDatePop(false);
      if (!field) return;
      if (ev.target.closest('[data-date-open]')) {
        if (dp.field === field) closeDatePop(true);
        else openDatePop(field);
      } else if (ev.target.closest('[data-date-clear]')) {
        closeDatePop(false);
        setDateField(field, '');
        dateParts(field).text.focus();
      }
    });
    document.addEventListener('input', (ev) => {
      const text = ev.target.closest('.date-field .date-input');
      if (!text) return;
      maskDateInput(text, ev);
      const field = text.closest('.date-field');
      dateParts(field).clear.hidden = !text.value;
      if (text.getAttribute('aria-invalid') && parseDMY(text.value) !== null) setDateError(field, '');
    });
    document.addEventListener('change', (ev) => {
      const text = ev.target.closest('.date-field .date-input');
      if (!text) return;
      const field = text.closest('.date-field');
      commitDateField(field);
      if (dp.field === field) renderDateCal();
    });
    document.addEventListener('keydown', (ev) => {
      const text = ev.target.closest && ev.target.closest('.date-field .date-input');
      if (!text) return;
      const field = text.closest('.date-field');
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        openDatePop(field);
      } else if (ev.key === 'Escape' && dp.field === field) {
        ev.preventDefault();
        dp.escAt = Date.now();
        closeDatePop(true);
      } else if (ev.key === 'Enter') {
        commitDateField(field);
      }
    });
    // Esc con el calendario abierto cierra solo el calendario, no el modal.
    $$('dialog').forEach((dlg) => {
      dlg.addEventListener('cancel', (ev) => {
        if (dp.field || Date.now() - dp.escAt < 300) {
          ev.preventDefault();
          closeDatePop(true);
        }
      });
      dlg.addEventListener('close', () => closeDatePop(false));
    });
    window.addEventListener('resize', positionDatePop);
    window.addEventListener('scroll', positionDatePop, true);
  }

  function estadoLabel(v) {
    return v.startsWith(EP_FILTER_PREFIX) ? `Endpoints: ${v.slice(EP_FILTER_PREFIX.length)}` : v;
  }

  function syncFilterUi() {
    const f = getFilters();
    $$('.filter-btn').forEach((b) => {
      const key = b.dataset.filter;
      b.classList.toggle('has-value', key === 'fecha' ? !!(f.desde || f.hasta) : !!f[key]);
    });
    const chips = [];
    if (f.desde || f.hasta) {
      let text = `${fmtShort(f.desde)} – ${fmtShort(f.hasta)}`;
      if (!f.hasta) text = `Desde ${fmtShort(f.desde)}`;
      if (!f.desde) text = `Hasta ${fmtShort(f.hasta)}`;
      chips.push({ key: 'fecha', name: 'Fecha de entrega', text });
    }
    ['responsable', 'desarrollo', 'estado'].forEach((k) => {
      if (f[k]) chips.push({ key: k, name: FILTER_DEFS[k].label, text: k === 'estado' ? estadoLabel(f[k]) : f[k] });
    });
    $('#filter-chips').innerHTML = chips.map((c) => `
      <li class="filter-chip" title="${esc(c.name)}: ${esc(c.text)}">
        <span>${esc(c.text)}</span>
        <button type="button" class="filter-chip-x" data-action="remove-filter" data-filter="${c.key}" aria-label="Quitar filtro ${esc(c.name)}: ${esc(c.text)}">${icn('close')}</button>
      </li>`).join('');
    $('#filter-chips-row').hidden = chips.length === 0;
  }

  function removeFilter(key) {
    if (key === 'fecha') {
      $('#f-desde').value = '';
      $('#f-hasta').value = '';
    } else if (FILTER_DEFS[key]) {
      $(`#f-${key}`).value = '';
    }
    renderAll();
    const btn = $(`.filter-btn[data-filter="${key}"]`);
    if (btn) btn.focus();
  }

  function openFilterPop(btn) {
    const key = btn.dataset.filter;
    if (state.pop && state.pop.key === key) {
      closeFilterPop(true);
      return;
    }
    closeFilterPop(false);
    const pop = $('#filter-pop');
    state.pop = { key, btn };
    if (key === 'fecha') {
      const desde = $('#f-desde').value;
      const hasta = $('#f-hasta').value;
      const base = parseDate(desde) || parseDate(hasta) || today();
      Object.assign(state.pop, {
        desde, hasta, dir: 'next', n: 7, unit: 'd',
        month: new Date(base.getFullYear(), base.getMonth(), 1),
        focusDay: toISO(base),
      });
      pop.className = 'filter-pop filter-pop-date';
      pop.setAttribute('aria-label', 'Filtrar por fecha de entrega');
      renderDatePop();
    } else {
      pop.className = `filter-pop filter-pop-list${key === 'estado' ? ' is-simple' : ''}`;
      pop.setAttribute('aria-label', `Filtrar por ${FILTER_DEFS[key].label.toLowerCase()}`);
      renderListPop('');
    }
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('is-open');
    positionFilterPop();
    const first = pop.querySelector('.pop-search input') || pop.querySelector('.pop-opt.is-selected') ||
      pop.querySelector('select, input, button');
    if (first) first.focus();
  }

  function closeFilterPop(returnFocus) {
    if (!state.pop) return;
    const { btn } = state.pop;
    state.pop = null;
    const pop = $('#filter-pop');
    pop.hidden = true;
    pop.innerHTML = '';
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('is-open');
    if (returnFocus) btn.focus();
  }

  function positionFilterPop() {
    if (!state.pop) return;
    const pop = $('#filter-pop');
    const r = state.pop.btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    pop.style.maxWidth = `${vw - 16}px`;
    const w = pop.offsetWidth;
    let left = r.left;
    if (left + w > vw - 8) left = vw - 8 - w;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.maxHeight = `${Math.max(200, vh - r.bottom - 14)}px`;
  }

  function filterOptionGroups(key) {
    if (key === 'estado') {
      return [
        { label: 'Estado de la API', items: ESTADOS_API.map((v) => ({ value: v, label: v })) },
        { label: 'Con endpoints / features en…', items: ESTADOS_EP.map((v) => ({ value: EP_FILTER_PREFIX + v, label: v })) },
      ];
    }
    return [{ items: (state.filterOpts[key] || []).map((v) => ({ value: v, label: v })) }];
  }

  function renderListPop(query) {
    const key = state.pop.key;
    const def = FILTER_DEFS[key];
    const current = $(`#f-${key}`).value;
    const q = fold(query.trim());
    const opt = (o) => `
      <button type="button" class="pop-opt${o.value === current ? ' is-selected' : ''}${o.value === '' ? ' is-all' : ''}" role="menuitemradio"
        aria-checked="${o.value === current}" data-value="${esc(o.value)}" tabindex="-1">
        <span class="pop-radio" aria-hidden="true"></span><span class="pop-opt-label">${esc(o.label)}</span>
      </button>`;
    let body = opt({ value: '', label: def.all });
    let count = 0;
    filterOptionGroups(key).forEach((g) => {
      const items = q ? g.items.filter((o) => fold(o.label).includes(q)) : g.items;
      count += items.length;
      if (!items.length) return;
      if (g.label) body += `<div class="pop-group" role="presentation">${esc(g.label)}</div>`;
      body += items.map(opt).join('');
    });
    if (!count) body += '<p class="pop-empty">Sin resultados</p>';
    const list = `<div class="pop-list" role="menu" aria-label="${esc(def.label)}">${body}</div>`;
    const pop = $('#filter-pop');
    if (def.search && pop.querySelector('.pop-list')) {
      pop.querySelector('.pop-list').outerHTML = list;
    } else {
      pop.innerHTML = (def.search
        ? `<div class="pop-search"><input type="search" placeholder="${esc(def.search)}" aria-label="${esc(def.search)}" autocomplete="off"></div>`
        : '') + list;
    }
    const sel = pop.querySelector('.pop-opt.is-selected') || pop.querySelector('.pop-opt');
    if (sel) sel.tabIndex = 0;
  }

  function pickFilterOption(value) {
    const key = state.pop.key;
    $(`#f-${key}`).value = value;
    closeFilterPop(true);
    renderAll();
  }

  function shiftDate(d, n, unit) {
    if (unit === 'm') return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n * (unit === 'w' ? 7 : 1));
  }

  function renderDatePop() {
    const p = state.pop;
    const sel = (opts, cur) => opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');
    $('#filter-pop').innerHTML = `
      <div class="pop-presets">
        <select data-preset="dir" aria-label="Rango rápido">${sel([['next', 'Próximos'], ['past', 'Últimos']], p.dir)}</select>
        <input type="number" data-preset="n" min="1" max="999" value="${p.n}" aria-label="Cantidad">
        <select data-preset="unit" aria-label="Unidad">${sel([['d', 'Día'], ['w', 'Semana'], ['m', 'Mes']], p.unit)}</select>
      </div>
      <div class="cal" id="pop-cal"></div>
      <div class="pop-range">
        <label>Desde<span class="range-input"><input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/aaaa" autocomplete="off" data-range="desde" value="${esc(fmtDMY(p.desde))}">${icn('calendar_month')}</span></label>
        <label>Hasta<span class="range-input"><input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/aaaa" autocomplete="off" data-range="hasta" value="${esc(fmtDMY(p.hasta))}">${icn('calendar_month')}</span></label>
      </div>
      <div class="pop-foot">
        <button type="button" class="pop-link" data-date-clear>Limpiar</button>
        <button type="button" class="btn btn-success btn-sm" data-date-apply>Aplicar filtro de fecha</button>
      </div>`;
    renderCalendar();
  }

  function renderCalendar() {
    const p = state.pop;
    const m = p.month;
    const offset = (m.getDay() + 6) % 7;
    const todayIso = toISO(today());
    const inMonth = (iso) => iso.slice(0, 7) === toISO(m).slice(0, 7);
    if (!inMonth(p.focusDay)) p.focusDay = toISO(m);
    let cells = '';
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(m.getFullYear(), m.getMonth(), 1 - offset + i);
      const iso = toISO(d);
      const cls = ['cal-day'];
      if (!inMonth(iso)) cls.push('is-out');
      if (iso === todayIso) cls.push('is-today');
      if (iso === p.desde) cls.push('is-start');
      if (iso === p.hasta) cls.push('is-end');
      if (p.desde && p.hasta && iso > p.desde && iso < p.hasta) cls.push('in-range');
      const picked = iso === p.desde || iso === p.hasta;
      const label = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      cells += `<button type="button" class="${cls.join(' ')}" data-cal-day="${iso}" aria-label="${esc(label)}" aria-pressed="${picked}"
        tabindex="${iso === p.focusDay ? 0 : -1}">${d.getDate()}</button>`;
    }
    $('#pop-cal').innerHTML = `
      <div class="cal-head">
        <span class="cal-title" aria-live="polite">${MESES[m.getMonth()]} ${m.getFullYear()}</span>
        <button type="button" class="filter-icon-btn" data-cal-nav="-1" aria-label="Mes anterior">${icn('chevron_left')}</button>
        <button type="button" class="filter-icon-btn" data-cal-nav="1" aria-label="Mes siguiente">${icn('chevron_right')}</button>
      </div>
      <div class="cal-grid" role="group" aria-label="${MESES[m.getMonth()]} ${m.getFullYear()}">
        ${DIAS_SEMANA.map((d) => `<span class="cal-dow" aria-hidden="true">${d}</span>`).join('')}
        ${cells}
      </div>`;
    const pop = $('#filter-pop');
    ['desde', 'hasta'].forEach((k) => {
      const inp = pop.querySelector(`[data-range="${k}"]`);
      inp.value = fmtDMY(p[k]);
      inp.removeAttribute('aria-invalid');
    });
  }

  function setCalMonth(d) {
    state.pop.month = new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function pickCalDay(iso) {
    const p = state.pop;
    if (!p.desde || p.hasta) {
      p.desde = iso;
      p.hasta = '';
    } else if (iso < p.desde) {
      p.hasta = p.desde;
      p.desde = iso;
    } else {
      p.hasta = iso;
    }
    p.focusDay = iso;
    setCalMonth(parseDate(iso));
    renderCalendar();
    const btn = $(`#pop-cal [data-cal-day="${iso}"]`);
    if (btn) btn.focus();
  }

  function applyPreset() {
    const p = state.pop;
    const pop = $('#filter-pop');
    p.dir = pop.querySelector('[data-preset="dir"]').value;
    p.unit = pop.querySelector('[data-preset="unit"]').value;
    p.n = Math.min(999, Math.max(1, parseInt(pop.querySelector('[data-preset="n"]').value, 10) || 1));
    const t = today();
    if (p.dir === 'past') {
      p.desde = toISO(shiftDate(t, -p.n, p.unit));
      p.hasta = toISO(t);
      setCalMonth(t);
    } else {
      p.desde = toISO(t);
      p.hasta = toISO(shiftDate(t, p.n, p.unit));
      setCalMonth(t);
    }
    p.focusDay = toISO(t);
    renderCalendar();
  }

  function bindFilterPop() {
    const pop = $('#filter-pop');
    pop.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!state.pop) return;
      const o = ev.target.closest('.pop-opt');
      if (o) { pickFilterOption(o.dataset.value); return; }
      const day = ev.target.closest('[data-cal-day]');
      if (day) { pickCalDay(day.dataset.calDay); return; }
      const nav = ev.target.closest('[data-cal-nav]');
      if (nav) {
        const m = state.pop.month;
        setCalMonth(new Date(m.getFullYear(), m.getMonth() + Number(nav.dataset.calNav), 1));
        renderCalendar();
        const again = $(`#pop-cal [data-cal-nav="${nav.dataset.calNav}"]`);
        if (again) again.focus();
        return;
      }
      if (ev.target.closest('[data-date-clear]')) {
        state.pop.desde = '';
        state.pop.hasta = '';
        renderCalendar();
        return;
      }
      if (ev.target.closest('[data-date-apply]')) {
        const { desde, hasta } = state.pop;
        $('#f-desde').value = desde;
        $('#f-hasta').value = hasta;
        closeFilterPop(true);
        renderAll();
      }
    });
    pop.addEventListener('input', (ev) => {
      if (state.pop && ev.target.closest('.pop-search')) renderListPop(ev.target.value);
      if (state.pop && ev.target.dataset.range) maskDateInput(ev.target, ev);
    });
    pop.addEventListener('change', (ev) => {
      if (!state.pop) return;
      if (ev.target.dataset.preset) { applyPreset(); return; }
      const which = ev.target.dataset.range;
      if (which) {
        const p = state.pop;
        const iso = parseDMY(ev.target.value);
        if (iso === null) {
          ev.target.setAttribute('aria-invalid', 'true');
          ev.target.title = DATE_ERROR;
          return;
        }
        p[which] = iso;
        ev.target.removeAttribute('title');
        if (p.desde && p.hasta && p.desde > p.hasta) [p.desde, p.hasta] = [p.hasta, p.desde];
        const d = parseDate(p[which]);
        if (d) { setCalMonth(d); p.focusDay = p[which]; }
        renderCalendar();
      }
    });
    pop.addEventListener('keydown', (ev) => {
      if (!state.pop) return;
      const opts = $$('.pop-opt', pop);
      const inSearch = ev.target.closest('.pop-search');
      if (opts.length && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && (inSearch || ev.target.closest('.pop-opt'))) {
        ev.preventDefault();
        let i = opts.indexOf(ev.target);
        if (inSearch) i = ev.key === 'ArrowDown' ? 0 : opts.length - 1;
        else i = (i + (ev.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
        opts.forEach((o) => { o.tabIndex = -1; });
        opts[i].tabIndex = 0;
        opts[i].focus();
        return;
      }
      if (inSearch && ev.key === 'Enter') {
        ev.preventDefault();
        const firstMatch = opts.find((o) => !o.classList.contains('is-all'));
        if (firstMatch) pickFilterOption(firstMatch.dataset.value);
        return;
      }
      const day = ev.target.closest('[data-cal-day]');
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (day && moves[ev.key] != null) {
        ev.preventDefault();
        const d = parseDate(day.dataset.calDay);
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + moves[ev.key]);
        state.pop.focusDay = toISO(next);
        setCalMonth(next);
        renderCalendar();
        const btn = $(`#pop-cal [data-cal-day="${toISO(next)}"]`);
        if (btn) btn.focus();
      }
    });
    pop.addEventListener('focusout', (ev) => {
      const to = ev.relatedTarget;
      if (state.pop && to && !pop.contains(to) && to !== state.pop.btn) closeFilterPop(false);
    });
    window.addEventListener('resize', positionFilterPop);
    window.addEventListener('scroll', positionFilterPop, true);
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
    const manual = state.sort === 'manual';
    const rows = sortItems(api.endpointsFeatures).map((e) => {
      return `
        <tr data-sort-item data-api-id="${esc(api.id)}" data-ep-id="${esc(e.id)}">
          ${manual ? `<td class="cell-handle">${dragHandle(`${e.metodo} ${e.rutaONombre}`, api.id, e.id)}</td>` : ''}
          <td>${methodTag(e.metodo)}</td>
          <td>
            <div class="ep-route">${esc(e.rutaONombre)}</div>
            <div class="ep-desc">${esc(e.descripcion)}</div>
            <div class="api-id">${esc(e.id)}</div>
          </td>
          <td>${e.responsableFeature ? esc(e.responsableFeature) : `<span class="inherited" title="Hereda el responsable de la API">${esc(api.responsable.nombre || '—')}</span>`}</td>
          <td>${dateChip(e.fechaEstimada, e.estado === 'Completado')}</td>
          <td>${prioSelect(e.prioridad, e.rutaONombre, api.id, e.id)}</td>
          <td>
            <select class="status-select status-${slug(e.estado)}" data-ep-status data-api-id="${esc(api.id)}" data-ep-id="${esc(e.id)}"
              aria-label="Estado de ${esc(e.rutaONombre)}" title="Cambiar estado">
              ${ESTADOS_EP.map((st) => `<option value="${esc(st)}"${st === e.estado ? ' selected' : ''}>${esc(st)}</option>`).join('')}
            </select>
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
            <dt>Prioridad</dt><dd>${prioSelect(api.prioridad, api.nombre, api.id)}</dd>
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
          <div class="detail-section-tools">
            ${api.endpointsFeatures.length > 1 ? sortToggleHtml() : ''}
            <button type="button" class="btn btn-sm btn-primary" data-action="new-ep" data-api-id="${esc(api.id)}">${icn('add')}Agregar endpoint / feature</button>
          </div>
        </div>
        ${api.endpointsFeatures.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr>${manual ? '<th class="cell-handle"><span class="sr-only">Orden</span></th>' : ''}<th>Método</th><th>Ruta / nombre</th><th>Responsable</th><th>Fecha estimada</th><th>Prioridad</th><th>Estado</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <p class="hint">${icn('info')}${manual
            ? 'Arrastrá desde ⋮⋮ (o usá las flechas ↑ ↓ sobre el control) para definir el orden manual. Elegí prioridad y estado desde sus desplegables.'
            : 'Vista ordenada por prioridad (Alta → Media → Baja). Cambiá a "Manual" para arrastrar y reordenar.'} Los cambios se guardan como borrador local hasta que los publiques.</p>`
        : '<div class="empty">Esta API todavía no tiene endpoints ni features cargados.</div>'}
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn btn-danger-ghost" data-action="delete-api" data-api-id="${esc(api.id)}">Eliminar API</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-secondary" data-action="edit-api" data-api-id="${esc(api.id)}">${icn('edit')}Editar API</button>
        <button type="button" class="btn btn-primary" data-action="close-modal">Cerrar</button>
      </footer>`;
  }

  function setEndpointStatus(apiId, epId, estado) {
    const api = findApi(apiId);
    const ep = api && api.endpointsFeatures.find((e) => e.id === epId);
    if (!ep || !ESTADOS_EP.includes(estado) || ep.estado === estado) return;
    ep.estado = estado;
    commit();
    toast(`"${ep.rutaONombre}" → ${ep.estado}`, 'success');
  }

  function setPrioridad(apiId, epId, prioridad) {
    const api = findApi(apiId);
    const target = api && (epId ? api.endpointsFeatures.find((e) => e.id === epId) : api);
    if (!target || !PRIORIDADES.includes(prioridad) || target.prioridad === prioridad) return;
    target.prioridad = prioridad;
    commit();
    toast(`Prioridad de "${epId ? target.rutaONombre : target.nombre}" → ${prioridad}`, 'success');
  }

  // ---------------------------------------------------------------------------
  // Orden manual (arrastrar y soltar con mouse/touch + teclado)
  // ---------------------------------------------------------------------------
  let drag = null;

  function announce(msg) {
    const live = $('#sr-live');
    if (live) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); }
  }

  function sortListFor(apiId, epId) {
    if (!epId) return state.data.apis;
    const api = findApi(apiId);
    return api ? api.endpointsFeatures : null;
  }

  function itemKey(el) {
    return el.dataset.epId || el.dataset.apiId;
  }

  function itemLabel(apiId, epId) {
    const api = findApi(apiId);
    if (!api) return '';
    if (!epId) return api.nombre;
    const ep = api.endpointsFeatures.find((e) => e.id === epId);
    return ep ? `${ep.metodo} ${ep.rutaONombre}` : '';
  }

  function applyMove(apiId, epId, targetKey, after) {
    const list = sortListFor(apiId, epId);
    if (!list || !moveInList(list, epId || apiId, targetKey, after)) return false;
    commit();
    return true;
  }

  function focusHandle(apiId, epId) {
    const sel = epId
      ? `[data-drag-handle][data-ep-id="${CSS.escape(epId)}"]`
      : `[data-drag-handle][data-api-id="${CSS.escape(apiId)}"]:not([data-ep-id])`;
    const h = $(sel);
    if (h) { h.focus(); h.scrollIntoView({ block: 'nearest' }); }
  }

  function clearDropMarks() {
    $$('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  function scrollParent(el) {
    return el.closest('.modal-body') || document.scrollingElement;
  }

  function onDragStart(ev) {
    const h = ev.target.closest('[data-drag-handle]');
    if (!h || ev.button > 0) return;
    const item = h.closest('[data-sort-item]');
    if (!item) return;
    ev.preventDefault();
    h.setPointerCapture(ev.pointerId);
    drag = { h, item, apiId: h.dataset.apiId, epId: h.dataset.epId || '', container: item.parentElement, target: null, after: false, x: ev.clientX, y: ev.clientY, scroller: scrollParent(item), raf: 0 };
    item.classList.add('is-dragging');
    document.body.classList.add('is-sorting');
  }

  function updateDropTarget() {
    if (!drag) return;
    const { x, y, item, container } = drag;
    const hit = document.elementFromPoint(x, y);
    const target = hit && hit.closest('[data-sort-item]');
    clearDropMarks();
    if (!target || target === item || target.parentElement !== container) { drag.target = null; return; }
    const r = target.getBoundingClientRect();
    const grid = container.classList.contains('api-grid');
    const after = grid ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    drag.target = target;
    drag.after = after;
    target.classList.add(after ? 'drop-after' : 'drop-before');
  }

  function autoScroll() {
    if (!drag) return;
    const sc = drag.scroller;
    const bar = sc === document.scrollingElement ? $('.topbar') : null;
    const rect = sc === document.scrollingElement
      ? { top: bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0, bottom: window.innerHeight }
      : sc.getBoundingClientRect();
    const edge = 56;
    let dy = 0;
    if (drag.y < rect.top + edge) dy = -Math.ceil((rect.top + edge - drag.y) / 4);
    else if (drag.y > rect.bottom - edge) dy = Math.ceil((drag.y - (rect.bottom - edge)) / 4);
    if (dy) {
      sc.scrollTop += dy;
      updateDropTarget();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function onDragMove(ev) {
    if (!drag) return;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    if (!drag.raf) drag.raf = requestAnimationFrame(autoScroll);
    updateDropTarget();
  }

  function onDragEnd(ev, cancel) {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    clearDropMarks();
    d.item.classList.remove('is-dragging');
    document.body.classList.remove('is-sorting');
    if (d.h.hasPointerCapture && ev && ev.pointerId != null && d.h.hasPointerCapture(ev.pointerId)) d.h.releasePointerCapture(ev.pointerId);
    if (cancel || !d.target) return;
    if (applyMove(d.apiId, d.epId, itemKey(d.target), d.after)) {
      const label = itemLabel(d.apiId, d.epId);
      toast(`Orden actualizado: "${label}" (borrador local).`, 'success');
      announce(`${label} movido.`);
    }
  }

  function onHandleKey(ev) {
    const h = ev.target.closest('[data-drag-handle]');
    if (!h) return;
    const up = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft';
    const down = ev.key === 'ArrowDown' || ev.key === 'ArrowRight';
    if (!up && !down) return;
    ev.preventDefault();
    const item = h.closest('[data-sort-item]');
    const siblings = $$(':scope > [data-sort-item]', item.parentElement);
    const idx = siblings.indexOf(item);
    const neighbor = siblings[idx + (up ? -1 : 1)];
    const { apiId } = h.dataset;
    const epId = h.dataset.epId || '';
    if (!neighbor) { announce(up ? 'Ya está primero.' : 'Ya está último.'); return; }
    if (applyMove(apiId, epId, itemKey(neighbor), down)) {
      focusHandle(apiId, epId);
      announce(`${itemLabel(apiId, epId)}: posición ${idx + (up ? 0 : 2)} de ${siblings.length}.`);
    }
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
    form.elements.prioridad.value = api ? api.prioridad : PRIORIDAD_DEFAULT;
    setDateField($('#api-fecha').closest('.date-field'), api ? api.fechaEstimadaEntrega : '');
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
    const fechaOk = commitDateField($('#api-fecha').closest('.date-field'));
    const fecha = str(el.fechaEstimadaEntrega.value);

    let error = '';
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) error = 'El ID es obligatorio y solo admite minúsculas, números, puntos, guiones y guiones bajos.';
    else if (id !== originalId && findApi(id)) error = `Ya existe una API con el ID "${id}".`;
    else if (!nombre) error = 'El nombre es obligatorio.';
    else if (!respNombre) error = 'El responsable es obligatorio.';
    else if (!ESTADOS_API.includes(el.estadoGeneral.value)) error = 'Seleccioná un estado válido.';
    else if (!PRIORIDADES.includes(el.prioridad.value)) error = 'Seleccioná una prioridad válida.';
    else if (!fechaOk || (fecha && !parseDate(fecha))) error = 'La fecha estimada de entrega no es válida. Usá el formato dd/mm/aaaa.';
    if (error) { errBox.textContent = error; return; }

    const existing = originalId ? findApi(originalId) : null;
    const api = {
      id,
      nombre,
      contexto: str(el.contexto.value),
      responsable: { nombre: respNombre, rol: str(el.responsableRol.value) },
      desarrolloAfectado: uniq(el.desarrolloAfectado.value.split(',').map(str).filter(Boolean)),
      estadoGeneral: el.estadoGeneral.value,
      prioridad: el.prioridad.value,
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
    form.elements.prioridad.value = ep ? ep.prioridad : PRIORIDAD_DEFAULT;
    setDateField($('#ep-fecha').closest('.date-field'), ep ? ep.fechaEstimada : (api.fechaEstimadaEntrega || ''));
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
    const fechaOk = commitDateField($('#ep-fecha').closest('.date-field'));
    const fecha = str(el.fechaEstimada.value);

    let error = '';
    if (!id) error = 'El ID es obligatorio.';
    else if (id !== originalId && api.endpointsFeatures.some((e) => e.id === id)) error = `Ya existe un endpoint con el ID "${id}" en esta API.`;
    else if (!METODOS.includes(el.metodo.value)) error = 'Seleccioná un método válido.';
    else if (!ruta) error = 'La ruta o nombre es obligatoria.';
    else if (!ESTADOS_EP.includes(el.estado.value)) error = 'Seleccioná un estado válido.';
    else if (!PRIORIDADES.includes(el.prioridad.value)) error = 'Seleccioná una prioridad válida.';
    else if (!fechaOk || (fecha && !parseDate(fecha))) error = 'La fecha estimada no es válida. Usá el formato dd/mm/aaaa.';
    if (error) { errBox.textContent = error; return; }

    const ep = {
      id,
      metodo: el.metodo.value,
      rutaONombre: ruta,
      descripcion: str(el.descripcion.value),
      estado: el.estado.value,
      prioridad: el.prioridad.value,
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
        closeFilterPop(false);
        ['#f-search', '#f-responsable', '#f-desarrollo', '#f-estado', '#f-desde', '#f-hasta'].forEach((s) => { $(s).value = ''; });
        renderAll();
        break;
      case 'open-filter': openFilterPop(el); break;
      case 'remove-filter': removeFilter(el.dataset.filter); break;
      case 'set-view':
        state.view = el.dataset.view === 'table' ? 'table' : 'cards';
        lsSet(LS.view, state.view);
        renderAll();
        break;
      case 'set-sort':
        state.sort = SORT_MODES.includes(el.dataset.sortMode) ? el.dataset.sortMode : 'manual';
        lsSet(LS.sort, state.sort);
        renderAll();
        announce(state.sort === 'manual' ? 'Orden manual. Podés arrastrar para reordenar.' : 'Ordenado por prioridad.');
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
      if (state.pop && !ev.target.closest('#filter-pop, [data-action="open-filter"]')) closeFilterPop(false);
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

    document.addEventListener('change', (ev) => {
      const sel = ev.target.closest('select[data-ep-status]');
      if (sel) setEndpointStatus(sel.dataset.apiId, sel.dataset.epId, sel.value);
      const prio = ev.target.closest('select[data-prio]');
      if (prio) setPrioridad(prio.dataset.apiId, prio.dataset.epId || '', prio.value);
    });

    document.addEventListener('pointerdown', onDragStart);
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', (ev) => onDragEnd(ev, false));
    document.addEventListener('pointercancel', (ev) => onDragEnd(ev, true));

    document.addEventListener('keydown', (ev) => {
      if (ev.target.closest && ev.target.closest('[data-drag-handle]')) onHandleKey(ev);
      if (ev.key === 'Escape') {
        if (drag) {
          ev.preventDefault();
          onDragEnd(null, true);
          return;
        }
        if (state.pop) {
          ev.preventDefault();
          closeFilterPop(true);
        }
        closeMenu();
      }
    });
    bindFilterPop();
    bindDateFields();

    $('#f-search').addEventListener('input', renderAll);

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
    setOptions($('#api-estado'), ESTADOS_API);
    setOptions($('#ep-metodo'), METODOS);
    setOptions($('#ep-estado'), ESTADOS_EP);
    setOptions($('#api-prioridad'), PRIORIDADES);
    setOptions($('#ep-prioridad'), PRIORIDADES);
    state.view = lsGet(LS.view) === 'table' ? 'table' : 'cards';
    state.sort = SORT_MODES.includes(lsGet(LS.sort)) ? lsGet(LS.sort) : 'manual';
    bindEvents();
    await loadInitial();
    renderAll();
  }

  // Expuesto solo para pruebas manuales desde la consola.
  window.ACA_APIS = { state, normalizeData, utf8ToBase64, base64ToUtf8, serializeData };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
