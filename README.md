# 🌾 ACA · Tablero de seguimiento de APIs

Dashboard web estático (HTML + CSS + JavaScript vanilla, sin build) para hacer el **seguimiento integral del desarrollo de todas las APIs de ACA**. Se publica en **GitHub Pages** y permite visualizar, filtrar y **editar** la información de cada API directamente desde el navegador. Los datos viven versionados en Git en [`data/apis.json`](data/apis.json).

## Contenido del repositorio

```
.
├── index.html                    # Estructura de la SPA (tablero, filtros, modales)
├── styles.css                    # Estilos corporativos y responsive
├── app.js                        # Lógica: render, filtros, edición, GitHub API, import/export
├── data/
│   └── apis.json                 # Fuente de verdad: catálogo y estado de las APIs
├── .nojekyll                     # Evita el procesamiento Jekyll en Pages
└── .github/workflows/deploy.yml  # Valida y despliega en GitHub Pages en cada push a main
```

## ¿Cómo funciona el tablero?

- **KPIs superiores**: total de APIs, % de avance global (endpoints/features completados sobre el total), endpoints completados vs. pendientes y **alertas** de entregas vencidas o próximas (≤ 14 días) de APIs y endpoints sin completar. Los KPIs se recalculan según los filtros activos.
- **Búsqueda y filtros combinables**: texto libre (nombre, contexto, rutas, responsables…), **Responsable** (de la API o de alguna feature), **Desarrollo afectado**, **Estado** y **rango de fecha de entrega**.
- **Vista de tarjetas o tabla** con contexto, responsable, etiquetas de desarrollos afectados, fecha estimada (resaltada si está vencida o próxima) y **barra de progreso** calculada automáticamente.
- **Desglose por API** (botón *Ver desglose*): tabla de endpoints/features con método, ruta, responsable (hereda el de la API si está vacío), fecha y estado. **Un clic sobre el estado** lo pasa al siguiente: `Pendiente → En Progreso → Completado → Bloqueado`.
- **Alta, edición y eliminación** de APIs y endpoints mediante formularios con validación.

### Modelo de datos (`data/apis.json`)

```jsonc
{
  "version": 1,
  "actualizado": "2026-11-10T22:00:00.000Z",
  "apis": [
    {
      "id": "api-logistica-01",
      "nombre": "API de Logística y Acopios",
      "contexto": "Descripción funcional y técnica…",
      "responsable": { "nombre": "María Fernández", "rol": "Tech Lead · Equipo Logística" },
      "desarrolloAfectado": ["ERP SAP", "App Acopios Móvil"],
      "estadoGeneral": "En Desarrollo",        // Planificada | En Desarrollo | En QA / Testing | En Producción | Bloqueada
      "fechaEstimadaEntrega": "2026-12-15",    // YYYY-MM-DD
      "endpointsFeatures": [
        {
          "id": "log-ep-01",
          "metodo": "GET",                     // GET | POST | PUT | PATCH | DELETE | EVENT/ASYNC | FEATURE
          "rutaONombre": "/v1/acopios",
          "descripcion": "Qué resuelve",
          "estado": "Completado",              // Pendiente | En Progreso | Completado | Bloqueado
          "responsableFeature": "",            // vacío = hereda el responsable de la API
          "fechaEstimada": "2026-10-10"
        }
      ]
    }
  ]
}
```

El progreso de cada API = endpoints `Completado` / total de endpoints (si no tiene endpoints: 100 % cuando está `En Producción`, 0 % en otro caso).

## Activar GitHub Pages en 3 pasos

1. Subí este contenido a la rama **`main`** del repositorio.
2. En GitHub andá a **Settings → Pages** y en **Build and deployment → Source** elegí **GitHub Actions**.
3. Hacé un push a `main` (o ejecutá manualmente el workflow *Deploy dashboard a GitHub Pages* desde la pestaña **Actions**). Al terminar, la URL aparece en *Settings → Pages* y en el resumen del workflow, por ejemplo `https://<owner>.github.io/<repositorio>/`.

El workflow valida que `data/apis.json` sea JSON válido sin IDs duplicados y que `app.js` no tenga errores de sintaxis antes de publicar. **Cada commit en `main` —incluidos los que hace el propio dashboard— vuelve a desplegar el sitio.**

## Cómo editar los datos desde la interfaz

Todos los cambios hechos en la web (crear/editar/eliminar APIs o endpoints, cambiar estados) se guardan **al instante como borrador en el `localStorage`** de tu navegador. Mientras haya borrador aparece un aviso amarillo de **“cambios sin publicar”**; al recargar la página se retoma el borrador. Para que el resto del equipo los vea, publicalos con alguno de estos dos mecanismos:

### Opción A · Guardado directo con token de GitHub (recomendado)

1. Creá un **Personal Access Token** en GitHub → *Settings → Developer settings → Personal access tokens*:
   - **Fine-grained** (recomendado): acceso solo a este repositorio, permiso **Repository permissions → Contents: Read and write**.
   - Clásico: scope `repo` (o `public_repo` si el repositorio es público).
   - Si la organización usa SSO, autorizá el token para la organización.
2. En el dashboard: **⋯ Más → ⚙ Configuración GitHub**. Owner y repositorio se **autodetectan** cuando el sitio se sirve desde `https://<owner>.github.io/<repo>/`; completá rama (`main`), ruta (`data/apis.json`) y pegá el token. Usá **Probar conexión** para verificar acceso y permisos de escritura.
3. Presioná **⬆ Guardar en Repositorio**. La app:
   1. Lee el archivo actual (`GET /repos/{owner}/{repo}/contents/data/apis.json`) para obtener su `sha`.
   2. Si alguien lo modificó después de que cargaste los datos, te avisa del **conflicto** y te deja cancelar o sobrescribir.
   3. Hace `PUT /repos/{owner}/{repo}/contents/data/apis.json` con el JSON codificado en Base64 (seguro para UTF‑8: acentos, ñ, etc.), creando un **commit automático**.
   4. Limpia el borrador local. GitHub Pages se actualiza solo en 1–2 minutos.

Errores habituales y su mensaje: token inválido/vencido (401), sin permisos o límite de API (403), repo/rama/ruta inexistente (404), conflicto de versiones (409/422). Ante cualquier error **tus cambios no se pierden**: siguen en el borrador local.

> 🔐 El token se guarda **solo en el `localStorage` de tu navegador** y solo se envía a `api.github.com`. Nunca se commitea. Usá **Olvidar token** en equipos compartidos.

Con el token configurado, el tablero también lee los datos directamente desde la API de GitHub, por lo que ves los cambios al instante aunque Pages todavía no haya terminado de redesplegar.

### Opción B · Exportar / importar JSON (sin token)

1. Editá visualmente y luego **⋯ Más → ⬇ Exportar JSON**: se descarga `apis-aca-AAAA-MM-DD.json`.
2. Reemplazá `data/apis.json` en el repositorio con ese archivo y subilo por **commit** o **Pull Request** (ideal si querés revisión antes de publicar).
3. Para continuar el trabajo de otra persona o restaurar una versión, usá **⋯ Más → ⬆ Importar JSON** (valida el formato y lo carga como borrador).

Otras acciones: **⟳ Recargar desde repositorio** / **Descartar borrador** vuelven a la versión publicada.

## Compartir el tablero con el equipo

- **Público**: compartí la URL de Pages (`https://<owner>.github.io/<repositorio>/`). Cualquiera puede consultar; solo quienes tengan token con permiso de escritura pueden publicar cambios.
- **Interno**: en repositorios de una organización con GitHub Enterprise Cloud podés restringir la visibilidad del sitio a miembros (*Settings → Pages → Visibility → Private*).
- Quienes no tengan permisos pueden proponer cambios con **Exportar JSON** + Pull Request.

## Probarlo localmente

Los navegadores bloquean `fetch` sobre `file://`, así que serví la carpeta con un servidor estático:

```bash
python -m http.server 8000
# o
npx serve .
```

y abrí <http://localhost:8000>. Localmente owner/repo no se autodetectan: configuralos en **Configuración GitHub** si querés probar el guardado directo.

## Seguridad

- Todo el contenido dinámico se escapa antes de renderizarse (protección contra XSS) y no se usan manejadores inline.
- El token nunca se incluye en el repositorio ni en el JSON exportado.
- Recomendado: proteger la rama `main` solo si el flujo es por Pull Request; para guardado directo desde el dashboard, el token debe poder escribir en la rama configurada.
