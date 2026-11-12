#!/usr/bin/env node
// Sincroniza los cambios de data/apis.json con los tickets de Jira (Jira Cloud REST API v3).
// El ticket de cada API es su campo `id` en mayúsculas (agn-906 -> AGN-906).
// Sin dependencias: Node 20+ (fetch nativo).
//
// Uso:
//   node jira/sync.mjs --before-ref HEAD~1 [--after data/apis.json] [--dry-run]
//   node jira/sync.mjs --before viejo.json --after data/apis.json --dry-run
// Credenciales (solo por variables de entorno / secrets): JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROPERTY_KEY = 'aca-apis-sync';
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const MAX_ENDPOINT_CHANGES = 10;

// ---------------------------------------------------------------- lógica pura

export function ticketKey(id) {
  const key = String(id == null ? '' : id).trim().toUpperCase();
  return KEY_RE.test(key) ? key : null;
}

export function apisOf(data) {
  if (!data) return [];
  const list = Array.isArray(data) ? data : data.apis;
  return Array.isArray(list) ? list.filter((a) => a && a.id) : [];
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// La versión entra en el hash: al cambiar qué se sincroniza (v2: fecha de vencimiento) se re-sincronizan los tickets.
export const SYNC_VERSION = 2;

export function syncHash(api) {
  return createHash('sha256').update(stableStringify({ v: SYNC_VERSION, api })).digest('hex').slice(0, 16);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Fecha de vencimiento deseada en Jira: la fecha estimada de entrega de la API si es válida (YYYY-MM-DD).
export function dueDateOf(api) {
  const f = String((api && api.fechaEstimadaEntrega) || '').trim();
  return DATE_RE.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`)) ? f : '';
}

// Qué hacer con el campo duedate del ticket: { action: 'set' | 'clear' | 'none', value }.
export function planDueDate(api, currentDueDate, config = {}) {
  if (config.dueDate === false) return { action: 'none' };
  const want = dueDateOf(api);
  const cur = currentDueDate || '';
  if (want) return want === cur ? { action: 'none', value: want } : { action: 'set', value: want, from: cur };
  if (cur && config.clearDueDate === true) return { action: 'clear', value: null, from: cur };
  return { action: 'none' };
}

const endpointsOf = (api) => (Array.isArray(api && api.endpointsFeatures) ? api.endpointsFeatures : []);
const prioridadOf = (x) => (x && x.prioridad) || 'Media';

// Completa los valores por defecto que el tablero agrega al guardar (prioridad = Media) para no detectar falsos cambios.
export function normalizeApi(api) {
  if (!api) return api;
  return { ...api, prioridad: prioridadOf(api), endpointsFeatures: endpointsOf(api).map((e) => ({ ...e, prioridad: prioridadOf(e) })) };
}
const responsableOf = (api) => {
  const r = api && api.responsable;
  if (!r) return '';
  if (typeof r === 'string') return r;
  return [r.nombre, r.rol].filter(Boolean).join(' · ');
};

// Misma fórmula que el tablero (app.js): completados / total; sin endpoints, 100 % solo si está En Producción.
export function summarize(api) {
  const eps = endpointsOf(api);
  const total = eps.length;
  const done = eps.filter((e) => e.estado === 'Completado').length;
  const pct = total ? Math.round((done * 100) / total) : api.estadoGeneral === 'En Producción' ? 100 : 0;
  const porEstado = {};
  for (const e of eps) porEstado[e.estado || 'Sin estado'] = (porEstado[e.estado || 'Sin estado'] || 0) + 1;
  return {
    nombre: api.nombre || api.id,
    estado: api.estadoGeneral || 'Sin estado',
    prioridad: prioridadOf(api),
    fecha: api.fechaEstimadaEntrega || '',
    responsable: responsableOf(api),
    done,
    total,
    pct,
    porEstado,
  };
}

const arrow = (a, b) => `${a || '—'} → ${b || '—'}`;
const epLabel = (e) => `${e.metodo || ''} ${e.rutaONombre || e.id}`.trim();

export function describeChanges(prev, api) {
  if (!prev) return ['API registrada en el tablero.'];
  const out = [];
  const a = summarize(prev);
  const b = summarize(api);
  if (prev.nombre !== api.nombre) out.push(`Nombre: ${arrow(prev.nombre, api.nombre)}`);
  if (a.estado !== b.estado) out.push(`Estado: ${arrow(a.estado, b.estado)}`);
  if (a.prioridad !== b.prioridad) out.push(`Prioridad: ${arrow(a.prioridad, b.prioridad)}`);
  if (a.fecha !== b.fecha) out.push(`Fecha estimada de entrega: ${arrow(a.fecha, b.fecha)}`);
  if (a.responsable !== b.responsable) out.push(`Responsable: ${arrow(a.responsable, b.responsable)}`);
  if (stableStringify(prev.desarrolloAfectado || []) !== stableStringify(api.desarrolloAfectado || [])) {
    out.push(`Desarrollo afectado: ${(api.desarrolloAfectado || []).join(', ') || '—'}`);
  }
  if ((prev.contexto || '') !== (api.contexto || '')) out.push('Contexto actualizado.');
  if (a.pct !== b.pct || a.done !== b.done || a.total !== b.total) {
    out.push(`Avance: ${a.pct}% (${a.done}/${a.total}) → ${b.pct}% (${b.done}/${b.total})`);
  }

  const before = new Map(endpointsOf(prev).map((e) => [e.id, e]));
  const after = new Map(endpointsOf(api).map((e) => [e.id, e]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  if (added.length) out.push(`Endpoints/features agregados (${added.length}): ${added.map((id) => epLabel(after.get(id))).slice(0, MAX_ENDPOINT_CHANGES).join('; ')}`);
  if (removed.length) out.push(`Endpoints/features eliminados (${removed.length}): ${removed.map((id) => epLabel(before.get(id))).slice(0, MAX_ENDPOINT_CHANGES).join('; ')}`);

  const epChanges = [];
  let otherEp = false;
  for (const [id, e] of after) {
    const o = before.get(id);
    if (!o) continue;
    const parts = [];
    if (o.estado !== e.estado) parts.push(`estado ${arrow(o.estado, e.estado)}`);
    if (prioridadOf(o) !== prioridadOf(e)) parts.push(`prioridad ${arrow(prioridadOf(o), prioridadOf(e))}`);
    if ((o.fechaEstimada || '') !== (e.fechaEstimada || '')) parts.push(`fecha ${arrow(o.fechaEstimada, e.fechaEstimada)}`);
    if (parts.length) epChanges.push(`${epLabel(e)}: ${parts.join(', ')}`);
    else if (stableStringify(o) !== stableStringify(e)) otherEp = true;
  }
  if (epChanges.length) {
    out.push(...epChanges.slice(0, MAX_ENDPOINT_CHANGES));
    if (epChanges.length > MAX_ENDPOINT_CHANGES) out.push(`… y ${epChanges.length - MAX_ENDPOINT_CHANGES} cambios más en endpoints/features.`);
  }
  const commonPrev = endpointsOf(prev).map((e) => e.id).filter((id) => after.has(id));
  const commonNext = endpointsOf(api).map((e) => e.id).filter((id) => before.has(id));
  if (commonPrev.join('\u0000') !== commonNext.join('\u0000')) out.push('Orden de endpoints/features actualizado.');
  if (otherEp) out.push('Descripciones u otros datos de endpoints/features actualizados.');
  if (!out.length) out.push('Otros datos de la API actualizados.');
  return out;
}

// Devuelve solo las APIs cuyo contenido cambió (o que son nuevas). Reordenar APIs no cuenta como cambio.
export function diffApis(beforeData, afterData) {
  const forced = !beforeData;
  const prevById = new Map(apisOf(beforeData).map((a) => [a.id, normalizeApi(a)]));
  const result = [];
  for (const raw of apisOf(afterData)) {
    const api = normalizeApi(raw);
    const prev = prevById.get(api.id);
    if (prev && stableStringify(prev) === stableStringify(api)) continue;
    result.push({
      id: api.id,
      key: ticketKey(api.id),
      api,
      prev: prev || null,
      isNew: !prev && !forced,
      estadoChanged: !prev || prev.estadoGeneral !== api.estadoGeneral,
      summary: summarize(api),
      changes: forced ? ['Sincronización manual del estado actual.'] : describeChanges(prev, api),
      hash: syncHash(api),
    });
  }
  return result;
}

export function normalizeName(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

export function targetStatuses(config, estado) {
  const map = (config && config.statusMap) || {};
  const list = map[estado];
  return Array.isArray(list) ? list : list ? [list] : [];
}

export function isInTarget(currentStatus, targets) {
  const cur = normalizeName(currentStatus);
  return targets.some((t) => normalizeName(t) === cur);
}

// Elige la transición cuyo estado destino (o nombre) coincide con el primer candidato posible del mapeo.
export function pickTransition(transitions, targets) {
  const list = Array.isArray(transitions) ? transitions : [];
  for (const target of targets) {
    const n = normalizeName(target);
    const byTo = list.find((t) => t.to && normalizeName(t.to.name) === n);
    if (byTo) return byTo;
    const byName = list.find((t) => normalizeName(t.name) === n);
    if (byName) return byName;
  }
  return null;
}

export function commentLines(entry, ctx = {}) {
  const s = entry.summary;
  const lines = [
    `Estado: ${s.estado}`,
    `Avance: ${s.pct}% (${s.done}/${s.total} endpoints/features completados)`,
    `Fecha estimada de entrega: ${s.fecha || 'sin fecha'}`,
    `Prioridad: ${s.prioridad}`,
  ];
  const detalle = Object.entries(s.porEstado).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (detalle) lines.push(`Endpoints/features por estado: ${detalle}`);
  const footer = [];
  if (ctx.commitUrl) footer.push({ text: `commit ${String(ctx.commit || '').slice(0, 7)}`, href: ctx.commitUrl });
  if (ctx.dashboardUrl) footer.push({ text: 'tablero de APIs', href: ctx.dashboardUrl });
  return { title: `Actualización automática desde el tablero de APIs · ${s.nombre}`, lines, changes: entry.changes, footer };
}

export function commentText(entry, ctx) {
  const c = commentLines(entry, ctx);
  return [
    c.title,
    ...c.lines.map((l) => `  • ${l}`),
    'Cambios:',
    ...c.changes.map((l) => `  - ${l}`),
    ...(c.footer.length ? [`Origen: ${c.footer.map((f) => `${f.text} (${f.href})`).join(' · ')}`] : []),
  ].join('\n');
}

const textNode = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [textNode(t)] }] })),
});

export function commentAdf(entry, ctx) {
  const c = commentLines(entry, ctx);
  const content = [
    { type: 'paragraph', content: [textNode(c.title, [{ type: 'strong' }])] },
    bullets(c.lines),
    { type: 'paragraph', content: [textNode('Cambios:', [{ type: 'strong' }])] },
    bullets(c.changes),
  ];
  if (c.footer.length) {
    const parts = [textNode('Origen: ')];
    c.footer.forEach((f, i) => {
      if (i) parts.push(textNode(' · '));
      parts.push(textNode(f.text, [{ type: 'link', attrs: { href: f.href } }]));
    });
    content.push({ type: 'paragraph', content: parts });
  }
  return { type: 'doc', version: 1, content };
}

// ---------------------------------------------------------------- Jira REST v3

export class JiraError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createJiraClient({ baseUrl, email, token, fetchImpl = globalThis.fetch }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new JiraError(0, 'JIRA_BASE_URL debe ser una URL https (ej. https://empresa.atlassian.net).');
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  async function call(method, p, body) {
    const res = await fetchImpl(`${base}/rest/api/3${p}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
    if (!res.ok) {
      const detail = json && (json.errorMessages || []).concat(Object.values(json.errors || {})).join(' ');
      throw new JiraError(res.status, `${method} ${p} -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return json;
  }
  const k = (key) => encodeURIComponent(key);
  return {
    getIssue: (key) => call('GET', `/issue/${k(key)}?fields=status,summary,duedate`),
    setDueDate: (key, date) => call('PUT', `/issue/${k(key)}`, { fields: { duedate: date } }),
    getProperty: async (key) => {
      try {
        const r = await call('GET', `/issue/${k(key)}/properties/${PROPERTY_KEY}`);
        return r ? r.value : null;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
    setProperty: (key, value) => call('PUT', `/issue/${k(key)}/properties/${PROPERTY_KEY}`, value),
    getTransitions: async (key) => ((await call('GET', `/issue/${k(key)}/transitions`)) || {}).transitions || [],
    transition: (key, id) => call('POST', `/issue/${k(key)}/transitions`, { transition: { id: String(id) } }),
    addComment: (key, adf) => call('POST', `/issue/${k(key)}/comment`, { body: adf }),
  };
}

// ---------------------------------------------------------------- ejecución

export async function syncEntry(entry, { client, config, ctx, log }) {
  const key = entry.key;
  let issue;
  try {
    issue = await client.getIssue(key);
  } catch (e) {
    if (e.status === 404) return log.warn(`${key}: el ticket no existe o no hay permiso para verlo; se omite.`), 'missing';
    if (e.status === 403) return log.warn(`${key}: sin permiso sobre el ticket; se omite.`), 'missing';
    throw e;
  }
  const prop = await client.getProperty(key);
  if (prop && prop.hash === entry.hash) {
    log.info(`${key}: ya sincronizado con este contenido (hash ${entry.hash}); sin cambios.`);
    return 'unchanged';
  }
  const current = issue && issue.fields && issue.fields.status ? issue.fields.status.name : '';
  if (config.transitions !== false && entry.estadoChanged) {
    const targets = targetStatuses(config, entry.summary.estado);
    if (!targets.length) log.info(`${key}: el estado "${entry.summary.estado}" no tiene mapeo; solo se comenta.`);
    else if (isInTarget(current, targets)) log.info(`${key}: ya está en "${current}".`);
    else {
      const t = pickTransition(await client.getTransitions(key), targets);
      if (!t) log.warn(`${key}: no hay transición desde "${current}" hacia ${targets.join(' / ')}; solo se comenta.`);
      else {
        try {
          await client.transition(key, t.id);
          log.info(`${key}: transición "${t.name}" → ${t.to ? t.to.name : '?'}.`);
        } catch (e) {
          if (e.status === 401) throw e;
          log.warn(`${key}: no se pudo aplicar la transición "${t.name}" (${e.message}); solo se comenta.`);
        }
      }
    }
  }
  const extra = [];
  const due = planDueDate(entry.api, issue && issue.fields ? issue.fields.duedate : '', config);
  if (due.action !== 'none') {
    try {
      await client.setDueDate(key, due.value);
      const line = `Fecha de vencimiento en Jira: ${arrow(due.from, due.value || 'sin fecha')}`;
      extra.push(line);
      log.info(`${key}: ${line}.`);
    } catch (e) {
      if (e.status === 401) throw e;
      log.warn(`${key}: no se pudo actualizar la fecha de vencimiento (${e.message}); se continúa.`);
    }
  }
  if (config.comment !== false) {
    await client.addComment(key, commentAdf(extra.length ? { ...entry, changes: [...entry.changes, ...extra] } : entry, ctx));
    log.info(`${key}: comentario agregado.`);
  }
  await client.setProperty(key, { hash: entry.hash, commit: ctx.commit || null, syncedAt: new Date().toISOString() });
  return 'synced';
}

export async function run({ beforeData, afterData, config, dryRun, env, ctx, log, only, fetchImpl }) {
  const stats = { changed: 0, synced: 0, unchanged: 0, missing: 0, skipped: 0, failed: 0, planned: 0 };
  if (config.enabled === false) {
    log.info('Sincronización con Jira deshabilitada en jira/config.json.');
    return stats;
  }
  const ignore = new Set((config.ignoreIds || []).map((x) => String(x).toLowerCase()));
  let entries = diffApis(beforeData, afterData);
  if (only && only.length) entries = entries.filter((e) => only.includes(String(e.id).toLowerCase()));
  stats.changed = entries.length;
  if (!entries.length) {
    log.info('No hay APIs con cambios para sincronizar.');
    return stats;
  }
  let client = null;
  if (!dryRun) {
    const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((k) => !env[k]);
    if (missing.length) {
      log.warn(`Faltan los secrets ${missing.join(', ')}; no se sincroniza con Jira (${entries.length} APIs con cambios).`);
      stats.skipped = entries.length;
      return stats;
    }
    client = createJiraClient({ baseUrl: env.JIRA_BASE_URL, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN, fetchImpl });
  }
  for (const entry of entries) {
    if (ignore.has(String(entry.id).toLowerCase())) {
      log.info(`${entry.id}: ignorada por configuración.`);
      stats.skipped++;
      continue;
    }
    if (!entry.key) {
      log.warn(`${entry.id}: el id no tiene formato de ticket de Jira (PROYECTO-123); se omite.`);
      stats.skipped++;
      continue;
    }
    if (dryRun) {
      const targets = entry.estadoChanged && config.transitions !== false ? targetStatuses(config, entry.summary.estado) : [];
      log.info(`[dry-run] ${entry.key}${entry.isNew ? ' (API nueva)' : ''}`);
      if (targets.length) log.info(`  Transición a: ${targets.join(' / ')} (si existe y no está ya en ese estado)`);
      if (config.dueDate !== false) {
        const due = dueDateOf(entry.api);
        if (due) log.info(`  Fecha de vencimiento: ${due} (si difiere de la actual)`);
        else if (config.clearDueDate === true) log.info('  Fecha de vencimiento: se borra (la API no tiene fecha)');
      }
      if (config.comment !== false) log.info(commentText(entry, ctx).split('\n').map((l) => `  | ${l}`).join('\n'));
      stats.planned++;
      continue;
    }
    try {
      stats[await syncEntry(entry, { client, config, ctx, log })]++;
    } catch (e) {
      if (e.status === 401) throw new JiraError(401, `Credenciales de Jira inválidas (HTTP 401). Revisá JIRA_EMAIL y JIRA_API_TOKEN.`);
      stats.failed++;
      log.error(`${entry.key}: ${e.message}`);
    }
  }
  return stats;
}

function parseArgs(argv) {
  const args = { after: 'data/apis.json', config: path.join(HERE, 'config.json'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--before') args.before = next();
    else if (a === '--before-ref') args.beforeRef = next();
    else if (a === '--after') args.after = next();
    else if (a === '--config') args.config = next();
    else if (a === '--commit') args.commit = next();
    else if (a === '--only') args.only = next().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  return args;
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readBefore(args) {
  if (args.before) return existsSync(args.before) && readFileSync(args.before, 'utf8').trim() ? readJsonFile(args.before) : null;
  if (args.beforeRef) {
    try {
      const txt = execFileSync('git', ['show', `${args.beforeRef}:${args.after.replace(/\\/g, '/')}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }
  return null;
}

function makeLog() {
  const gha = !!process.env.GITHUB_ACTIONS;
  return {
    info: (m) => console.log(m),
    warn: (m) => console.log(gha ? `::warning title=Jira::${m}` : `ADVERTENCIA: ${m}`),
    error: (m) => console.log(gha ? `::error title=Jira::${m}` : `ERROR: ${m}`),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Uso: node jira/sync.mjs (--before <archivo> | --before-ref <ref git>) [--after data/apis.json] [--dry-run] [--only id1,id2] [--commit sha] [--config jira/config.json]');
    return;
  }
  const config = readJsonFile(args.config);
  const afterData = readJsonFile(args.after);
  const beforeData = readBefore(args);
  if (!beforeData && !args.only) {
    console.log('No hay versión anterior de data/apis.json para comparar; usá --before/--before-ref o --only para sincronizar APIs puntuales.');
    return;
  }
  const env = process.env;
  const commit = args.commit || env.GITHUB_SHA || '';
  const repoUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` : '';
  const ctx = { commit, commitUrl: repoUrl && commit ? `${repoUrl}/commit/${commit}` : '', dashboardUrl: config.dashboardUrl || '' };
  const log = makeLog();
  const stats = await run({ beforeData, afterData, config, dryRun: args.dryRun, env, ctx, log, only: args.only });
  const line = `APIs con cambios: ${stats.changed} · sincronizadas: ${stats.synced} · ya al día: ${stats.unchanged} · tickets inexistentes: ${stats.missing} · omitidas: ${stats.skipped} · con error: ${stats.failed}${args.dryRun ? ` · planificadas (dry-run): ${stats.planned}` : ''}`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Sincronización con Jira\n\n${line}\n`);
  if (stats.failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log(process.env.GITHUB_ACTIONS ? `::error title=Jira::${e.message}` : `ERROR: ${e.message}`);
    process.exitCode = 1;
  });
}
