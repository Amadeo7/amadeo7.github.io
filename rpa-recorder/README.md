# rpa-recorder

Grabador de acciones del navegador (como el recorder de Power Automate) + reproductor con Playwright.
Graba clicks, texto, selects y Enter; guarda un flujo JSON; lo reproduce en cualquier maquina/servidor.

```bash
npm install
npx playwright install chromium        # o usa BROWSER_CHANNEL=chrome

# 1) Grabar (se abre un navegador; cierra la ventana para guardar)
npm run record -- bac_login --url https://www.sucursalelectronica.com/redir/showLogin.go

# 2) Reproducir
PASS='tu-clave' npm run play -- flows/bac_login.json --type-delay 70 --out salida.json
```

## Como saber que esta grabando
- En el navegador veras una etiqueta roja **"● REC n"** arriba a la derecha; se pone verde un instante en cada accion capturada y `n` sube.
- En la terminal aparece una linea `+ click ...` / `+ fill ...` por cada paso.
- Para terminar: cierra la ventana del navegador (o Ctrl+C en la terminal). Recien ahi se guarda `flows/<nombre>.json`.

## Como graba
- Cada elemento se guarda con **varios selectores** ordenados del mas estable al menos estable
  (`data-testid`, `id` no dinamico, `name`, `aria-label`, `placeholder`, texto del boton, css path).
  Al reproducir se usa el primero que apunte a un unico elemento.
- **Contrasenas:** los campos `type=password` nunca se guardan; quedan como `{{NOMBRE}}` y se listan en
  `requiredVars`. Pasalas con `--var NOMBRE=...` o variables de entorno.
- `--parametrize`: convierte tambien los demas textos escritos (usuario, montos) en variables.
- **Alt+Click** sobre un elemento: lo marca como dato a extraer (paso `extract`, sale en `outputs`).
  Para leer varias filas edita el JSON y pon `"all": true` con un selector de columna (ej. `td.monto`).
- Soporta iframes. Los eventos sinteticos (no hechos por una persona) se ignoran.
- Para sesion persistente (reutilizar cookies): `--profile .profile` en `record` y en `play`.

## Pasos del flujo (`flows/*.json`)
`goto`, `click`, `fill`, `press`, `select`, `waitFor` (selector, `urlPattern` o `ms`), `extract`, `screenshot`.
Edita el JSON a mano para agregar esperas, pasos `optional: true` o ajustar selectores.
Si un paso falla se guarda una captura en `artifacts/` y el error indica el numero de paso.

## Usarlo desde NestJS / codigo
```ts
import { runFlow } from 'rpa-recorder';
const { outputs } = await runFlow('flows/depositos.json', { vars: { PASS }, page /* sesion persistente */ });
```
Pasar `page` reutiliza la sesion ya iniciada (ver `../bac-bank-service`).

## Limites conocidos
- Los flujos se graban en una maquina con pantalla (o Xvfb). Reproducir si puede ser headless.
- Grabar con automatizacion programatica (como en `test/e2e.ts`) no registra `select` ni acciones
  no confiables; con una persona usando el navegador si se registran.
- Si el banco detecta automatizacion o pide 2FA/OTP, el grabador no lo resuelve.
- Revisa los flujos antes de subirlos a git: el usuario queda literal salvo con `--parametrize`.

## Prueba
`CHROMIUM_PATH=/ruta/a/chrome npm test` (levanta un banco falso, graba, reproduce y verifica).
