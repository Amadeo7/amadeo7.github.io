import { mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { BrowserContext, chromium, Frame, Locator, Page } from 'playwright';
import { Flow, Step, Target } from './types';

export interface RunOptions {
  vars?: Record<string, string>;
  headless?: boolean;
  profileDir?: string;
  channel?: string;
  executablePath?: string;
  /** Reutiliza una pagina ya abierta (ej. la sesion persistente del microservicio). */
  page?: Page;
  slowMo?: number;
  /** Retraso entre teclas al escribir (simula teclado fisico). 0 = fill instantaneo. */
  typeDelayMs?: number;
  /** Timeout por paso en ms. */
  timeoutMs?: number;
  artifactsDir?: string;
  log?: (msg: string) => void;
}

export interface RunResult {
  ok: true;
  outputs: Record<string, string | string[]>;
  durationMs: number;
}

export class FlowError extends Error {
  constructor(message: string, public stepIndex: number, public step: Step, public screenshot?: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadFlow(file: string): Flow {
  return JSON.parse(readFileSync(file, 'utf8')) as Flow;
}

/** Reemplaza {{VAR}} y {{ENV:VAR}} usando `vars` y luego process.env. */
export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(?:ENV:)?([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name] ?? process.env[name];
    if (v === undefined) throw new Error(`Falta la variable ${name}`);
    return v;
  });
}

async function findScope(page: Page, target: Target, timeout: number): Promise<Page | Frame> {
  const ref = target.frame;
  if (!ref) return page;
  const match = (f: Frame) => {
    if (f === page.mainFrame()) return false;
    if (ref.name && f.name() === ref.name) return true;
    if (!ref.url) return false;
    try {
      const a = new URL(f.url());
      const b = new URL(ref.url);
      return a.origin === b.origin && a.pathname === b.pathname;
    } catch {
      return false;
    }
  };
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const f = page.frames().find(match);
    if (f) return f;
    await sleep(200);
  }
  throw new Error(`No se encontro el iframe ${ref.name ?? ref.url}`);
}

/** Prueba los selectores en orden; prefiere los que apuntan a un unico elemento. */
async function resolveTarget(page: Page, target: Target, timeout: number): Promise<Locator> {
  const scope = await findScope(page, target, timeout);
  const end = Date.now() + timeout;
  while (true) {
    let anyMatch: Locator | undefined;
    for (const c of target.candidates) {
      const loc = scope.locator(c);
      const n = await loc.count().catch(() => 0);
      if (n === 1) return loc;
      if (n > 1 && !anyMatch) anyMatch = loc.first();
    }
    // En el ultimo 30% del tiempo aceptamos un selector ambiguo antes que fallar.
    if (anyMatch && Date.now() > end - timeout * 0.3) return anyMatch;
    if (Date.now() >= end) throw new Error(`Elemento no encontrado: ${target.candidates.join(' | ')}`);
    await sleep(250);
  }
}

async function exec(page: Page, step: Step, o: Required<Pick<RunOptions, 'timeoutMs' | 'typeDelayMs'>>, vars: Record<string, string>, outputs: RunResult['outputs'], artifacts: string) {
  const timeout = o.timeoutMs;
  const settle = () => page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
  switch (step.type) {
    case 'goto':
      await page.goto(interpolate(step.url, vars), { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 60_000) });
      break;
    case 'click': {
      const loc = await resolveTarget(page, step.target, timeout);
      await loc.click({ timeout });
      await settle();
      break;
    }
    case 'fill': {
      const loc = await resolveTarget(page, step.target, timeout);
      const value = interpolate(step.value, vars);
      if (o.typeDelayMs > 0) {
        await loc.click({ timeout });
        await loc.fill('', { timeout });
        await loc.pressSequentially(value, { delay: o.typeDelayMs });
      } else {
        await loc.fill(value, { timeout });
      }
      break;
    }
    case 'press': {
      if (step.target) await (await resolveTarget(page, step.target, timeout)).press(step.key);
      else await page.keyboard.press(step.key);
      await settle();
      break;
    }
    case 'select':
      await (await resolveTarget(page, step.target, timeout)).selectOption(interpolate(step.value, vars));
      break;
    case 'waitFor': {
      if (step.ms) await sleep(step.ms);
      if (step.urlPattern) await page.waitForURL(new RegExp(step.urlPattern), { timeout });
      if (step.target) {
        const loc = await resolveTarget(page, step.target, timeout);
        await loc.waitFor({ state: step.state ?? 'visible', timeout });
      }
      break;
    }
    case 'extract': {
      const loc = await resolveTarget(page, step.target, timeout);
      const read = async (l: Locator) =>
        ((step.attr ? await l.getAttribute(step.attr) : await l.innerText()) ?? '').trim();
      if (step.all) {
        // `all` usa el primer selector que devuelva elementos.
        const scope = await findScope(page, step.target, timeout);
        const out: string[] = [];
        for (const c of step.target.candidates) {
          const l = scope.locator(c);
          const n = await l.count();
          if (n > 0) {
            for (let i = 0; i < n; i++) out.push(await read(l.nth(i)));
            break;
          }
        }
        outputs[step.as] = out;
      } else {
        outputs[step.as] = await read(loc);
      }
      break;
    }
    case 'screenshot':
      await page.screenshot({ path: join(artifacts, `${step.name ?? 'shot'}-${Date.now()}.png`), fullPage: true });
      break;
  }
}

export async function runFlow(flowOrPath: Flow | string, opts: RunOptions = {}): Promise<RunResult> {
  const flow = typeof flowOrPath === 'string' ? loadFlow(flowOrPath) : flowOrPath;
  const log = opts.log ?? (() => undefined);
  const vars = opts.vars ?? {};
  const artifacts = resolve(opts.artifactsDir ?? 'artifacts');
  mkdirSync(artifacts, { recursive: true });

  for (const v of flow.requiredVars ?? []) {
    if (vars[v] === undefined && process.env[v] === undefined) throw new Error(`Falta la variable requerida ${v}`);
  }

  let context: BrowserContext | undefined;
  let page = opts.page;
  let ownsBrowser = false;
  if (!page) {
    const launch = {
      headless: opts.headless ?? true,
      channel: opts.channel,
      executablePath: opts.executablePath,
      slowMo: opts.slowMo,
      viewport: { width: 1366, height: 768 },
    };
    context = opts.profileDir
      ? await chromium.launchPersistentContext(resolve(opts.profileDir), launch)
      : await (await chromium.launch(launch)).newContext({ viewport: launch.viewport });
    page = context.pages()[0] ?? (await context.newPage());
    ownsBrowser = true;
  }

  const started = Date.now();
  const outputs: RunResult['outputs'] = {};
  const o = { timeoutMs: opts.timeoutMs ?? 30_000, typeDelayMs: opts.typeDelayMs ?? 0 };
  try {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      log(`[${i + 1}/${flow.steps.length}] ${step.type}`);
      try {
        await exec(page, step, o, vars, outputs, artifacts);
      } catch (err) {
        if ('optional' in step && step.optional) {
          log(`  (paso opcional omitido: ${(err as Error).message})`);
          continue;
        }
        const shot = join(artifacts, `fail-${flow.name}-step${i + 1}-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        throw new FlowError(`Paso ${i + 1} (${step.type}) fallo: ${(err as Error).message}`, i, step, shot);
      }
    }
    return { ok: true, outputs, durationMs: Date.now() - started };
  } finally {
    if (ownsBrowser) {
      const browser = context?.browser();
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}
