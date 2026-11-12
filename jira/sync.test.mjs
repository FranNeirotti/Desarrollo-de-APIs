import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ticketKey, diffApis, summarize, pickTransition, targetStatuses, isInTarget,
  syncHash, commentText, commentAdf, run, PROPERTY_KEY,
} from './sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = () => JSON.parse(readFileSync(path.join(ROOT, 'data/apis.json'), 'utf8'));
const config = JSON.parse(readFileSync(path.join(ROOT, 'jira/config.json'), 'utf8'));
const silent = { info() {}, warn() {}, error() {} };

// Transiciones reales de AGN-906 (estado actual "Ajustes").
const TRANSITIONS = [
  { id: '13', name: 'Cancelado', to: { name: 'Cancelado' } },
  { id: '14', name: 'En pausa', to: { name: 'En pausa' } },
  { id: '18', name: 'Testing', to: { name: 'Pruebas' } },
];

test('ticketKey: id en mayúsculas y validación de formato', () => {
  assert.equal(ticketKey('agn-906'), 'AGN-906');
  assert.equal(ticketKey(' peg-256 '), 'PEG-256');
  assert.equal(ticketKey('api-logistica-01'), null);
  assert.equal(ticketKey(''), null);
});

test('sin cambios no sincroniza nada; reordenar APIs tampoco', () => {
  const data = real();
  assert.deepEqual(diffApis(data, real()), []);
  const reordered = real();
  reordered.apis.reverse();
  assert.deepEqual(diffApis(data, reordered), []);
});

test('agregar prioridad por defecto (Media) no cuenta como cambio', () => {
  const before = real();
  for (const a of before.apis) {
    delete a.prioridad;
    for (const e of a.endpointsFeatures || []) delete e.prioridad;
  }
  const after = JSON.parse(JSON.stringify(before));
  for (const a of after.apis) for (const e of a.endpointsFeatures || []) e.prioridad = 'Media';
  assert.deepEqual(diffApis(before, after), []);
});

test('el orden de las claves no altera el hash', () => {
  const api = real().apis[0];
  const shuffled = Object.fromEntries(Object.entries(api).reverse());
  assert.equal(syncHash(api), syncHash(shuffled));
});

test('cambio de estado de una API real', () => {
  const before = real();
  const after = real();
  const api = after.apis.find((a) => a.id === 'agn-906');
  const prev = api.estadoGeneral;
  api.estadoGeneral = 'En QA / Testing';
  const d = diffApis(before, after);
  assert.equal(d.length, 1);
  assert.equal(d[0].key, 'AGN-906');
  assert.equal(d[0].estadoChanged, true);
  assert.ok(d[0].changes.includes(`Estado: ${prev} → En QA / Testing`));
});

test('cambio de endpoint recalcula el avance igual que el tablero', () => {
  const before = real();
  const after = real();
  const api = after.apis.find((a) => a.id === 'agn-906');
  const s0 = summarize(api);
  assert.equal(s0.pct, Math.round((s0.done * 100) / s0.total));
  const ep = api.endpointsFeatures.find((e) => e.estado !== 'Completado');
  const old = ep.estado;
  ep.estado = 'Completado';
  const [entry] = diffApis(before, after);
  assert.equal(entry.estadoChanged, false);
  assert.equal(entry.summary.done, s0.done + 1);
  assert.ok(entry.changes.some((c) => c.startsWith('Avance: ')));
  assert.ok(entry.changes.some((c) => c.includes(`estado ${old} → Completado`)));
  const txt = commentText(entry, { dashboardUrl: config.dashboardUrl });
  for (const s of ['Estado:', 'Avance:', 'Fecha estimada de entrega:', 'Prioridad:']) assert.ok(txt.includes(s), s);
  assert.equal(commentAdf(entry, {}).type, 'doc');
});

test('API sin endpoints en producción = 100 %', () => {
  assert.equal(summarize({ id: 'x-1', estadoGeneral: 'En Producción', endpointsFeatures: [] }).pct, 100);
  assert.equal(summarize({ id: 'x-1', estadoGeneral: 'En Desarrollo' }).pct, 0);
});

test('API nueva se sincroniza e intenta transición', () => {
  const before = real();
  const after = real();
  after.apis.push({ id: 'agn-999', nombre: 'Nueva', estadoGeneral: 'Planificada', endpointsFeatures: [] });
  const d = diffApis(before, after);
  assert.equal(d.length, 1);
  assert.equal(d[0].isNew, true);
  assert.equal(d[0].estadoChanged, true);
});

test('mapeo de estados a transiciones reales de Jira', () => {
  assert.equal(pickTransition(TRANSITIONS, targetStatuses(config, 'En QA / Testing')).id, '18');
  assert.equal(pickTransition(TRANSITIONS, targetStatuses(config, 'Bloqueada')).id, '14');
  assert.equal(pickTransition(TRANSITIONS, targetStatuses(config, 'Planificada')), null);
  assert.ok(isInTarget('pruebas', targetStatuses(config, 'En QA / Testing')));
  assert.ok(isInTarget('Listo', targetStatuses(config, 'En Producción')));
  for (const estado of ['Planificada', 'En Desarrollo', 'En QA / Testing', 'En Producción', 'Bloqueada']) {
    assert.ok(targetStatuses(config, estado).length, `mapeo para ${estado}`);
  }
});

// Jira simulado: AGN-906 existe en "Ajustes"; PEG-256 no existe.
function fakeJira() {
  const props = {};
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const p = new URL(url).pathname.replace('/rest/api/3', '');
    calls.push(`${opts.method} ${p}`);
    const json = (status, body) => ({ ok: status < 400, status, text: async () => (body ? JSON.stringify(body) : '') });
    const m = p.match(/^\/issue\/([^/]+)(.*)$/);
    if (!m) return json(404);
    const [, key, rest] = m;
    if (key !== 'AGN-906') return json(404, { errorMessages: ['La incidencia no existe'] });
    if (rest === '') return json(200, { fields: { status: { name: 'Ajustes' } } });
    if (rest === `/properties/${PROPERTY_KEY}`) {
      if (opts.method === 'PUT') { props[key] = JSON.parse(opts.body); return json(200, {}); }
      return props[key] ? json(200, { value: props[key] }) : json(404);
    }
    if (rest === '/transitions') return opts.method === 'GET' ? json(200, { transitions: TRANSITIONS }) : { ok: true, status: 204, text: async () => '' };
    if (rest === '/comment') return json(201, { id: '1' });
    return json(404);
  };
  return { fetchImpl, calls };
}

test('sincronización: transición + comentario, ticket inexistente e idempotencia', async () => {
  const before = real();
  const after = real();
  after.apis.find((a) => a.id === 'agn-906').estadoGeneral = 'En QA / Testing';
  after.apis.find((a) => a.id === 'peg-256').prioridad = 'Baja';
  const env = { JIRA_BASE_URL: 'https://ejemplo.atlassian.net/', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'x' };
  const { fetchImpl, calls } = fakeJira();
  const args = { beforeData: before, afterData: after, config, dryRun: false, env, ctx: {}, log: silent, fetchImpl };

  const s1 = await run(args);
  assert.deepEqual([s1.changed, s1.synced, s1.missing, s1.failed], [2, 1, 1, 0]);
  assert.ok(calls.includes('POST /issue/AGN-906/transitions'));
  assert.ok(calls.includes('POST /issue/AGN-906/comment'));

  calls.length = 0;
  const s2 = await run(args);
  assert.equal(s2.unchanged, 1);
  assert.ok(!calls.some((c) => c.startsWith('POST')), 'no repite comentario ni transición');
});

test('sin transición equivalente solo comenta; sin secrets no falla', async () => {
  const before = real();
  const after = real();
  after.apis.find((a) => a.id === 'agn-906').estadoGeneral = 'Planificada';
  const { fetchImpl, calls } = fakeJira();
  const env = { JIRA_BASE_URL: 'https://ejemplo.atlassian.net', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'x' };
  const s = await run({ beforeData: before, afterData: after, config, dryRun: false, env, ctx: {}, log: silent, fetchImpl });
  assert.equal(s.synced, 1);
  assert.ok(!calls.includes('POST /issue/AGN-906/transitions'));
  assert.ok(calls.includes('POST /issue/AGN-906/comment'));

  const s2 = await run({ beforeData: before, afterData: after, config, dryRun: false, env: {}, ctx: {}, log: silent });
  assert.equal(s2.skipped, 1);
});
