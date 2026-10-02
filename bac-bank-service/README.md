# bac-bank-service (fase 1: login BAC Honduras)

Microservicio NestJS + Playwright que reemplaza el subflujo `BAC_RPA_Login` de Power Automate.

## Diferencias frente al RPA
- **Sesion persistente** (`SESSION_DIR`): ya no se limpian cookies/cache en cada corrida.
- Una sola cola: nunca hay dos acciones simultaneas sobre la cuenta.
- Credenciales por variables de entorno (la contrasena DPAPI del RPA no es reutilizable).
- Captura de pantalla en `artifacts/` cuando el login falla.

## Uso
```bash
cp .env.example .env     # completa BAC_USER, BAC_PASSWORD, API_KEY
npm install
npm run codegen          # inspecciona el login y ajusta BAC_USER_SELECTOR / BAC_SUBMIT_SELECTOR / BAC_LOGGED_IN_SELECTOR
npm run start:dev
```

Endpoints (header `x-api-key`):
- `GET /health` (sin clave)
- `POST /session/login` — inicia sesion o reutiliza la existente
- `GET /session/status`
- `POST /session/close`

## Pendiente de confirmar con una prueba real
1. Selector del campo usuario y del boton (el RPA solo expone `input#pass`).
2. `BAC_LOGGED_IN_SELECTOR` (ej. enlace "Salir"): mas fiable que la heuristica por defecto.
3. Que el banco no pida validacion extra desde tu IP/servidor. Prueba primero con `HEADLESS=false`
   (en Docker se usa `xvfb-run`) y una IP fija.

## Siguientes fases
Depositos (`DepositsModule`), aceptacion de ventas (`SalesModule`), BullMQ + idempotencia, alertas.
