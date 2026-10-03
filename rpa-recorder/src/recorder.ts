import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { BrowserContext, chromium, Frame, Page } from 'playwright';
import { INJECT_SCRIPT } from './inject';
import { Flow, RawEvent, Step, Target } from './types';

export interface RecordOptions {
  name: string;
  url: string;
  headless?: boolean;
  /** Directorio de perfil persistente (cookies/sesion). Opcional. */
  profileDir?: string;
  channel?: string;
  executablePath?: string;
  /** Guardar tambien los textos escritos como variables ({{CAMPO}}), no literales. */
  parametrize?: boolean;
  log?: (msg: string) => void;
}

export interface RecordingHandle {
  page: Page;
  context: BrowserContext;
  /** Cierra el navegador y devuelve el flujo grabado. */
  stop(): Promise<Flow>;
  /** Se resuelve cuando el usuario cierra el navegador. */
  closed: Promise<Flow>;
}

const toVarName = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase() || 'FIELD';

export async function startRecording(opts: RecordOptions): Promise<RecordingHandle> {
  const log = opts.log ?? (() => undefined);
  const launch = {
    headless: opts.headless ?? false,
    channel: opts.channel,
    executablePath: opts.executablePath,
    viewport: { width: 1366, height: 768 },
  };
  const browser = opts.profileDir ? undefined : await chromium.launch(launch);
  const context = browser
    ? await browser.newContext({ viewport: launch.viewport })
    : await chromium.launchPersistentContext(opts.profileDir!, launch);

  const steps: Step[] = [{ type: 'goto', url: opts.url }];
  const requiredVars = new Set<string>();
  let extractCount = 0;
  let done = false;

  const targetFor = (frame: Frame, page: Page, candidates: string[], label?: string): Target => {
    const t: Target = { candidates, ...(label ? { label } : {}) };
    if (frame !== page.mainFrame()) t.frame = { name: frame.name() || undefined, url: frame.url() };
    return t;
  };

  await context.exposeBinding('__rpaRecord', (source, ev: RawEvent) => {
    const page = source.page;
    const target = targetFor(source.frame, page, ev.candidates, ev.label);
    let step: Step | undefined;
    switch (ev.type) {
      case 'click':
        step = { type: 'click', target };
        break;
      case 'fill': {
        let value = ev.value ?? '';
        let secret = false;
        if (ev.secret || opts.parametrize) {
          const v = toVarName(ev.field ?? 'FIELD');
          requiredVars.add(v);
          value = `{{${v}}}`;
          secret = !!ev.secret;
        }
        const prev = steps[steps.length - 1];
        // Si el usuario reescribe el mismo campo, nos quedamos con el ultimo valor.
        if (prev?.type === 'fill' && prev.target.candidates[0] === target.candidates[0]) steps.pop();
        step = { type: 'fill', target, value, ...(secret ? { secret } : {}) };
        break;
      }
      case 'press':
        step = { type: 'press', key: ev.key ?? 'Enter', ...(ev.candidates.length ? { target } : {}) };
        break;
      case 'select':
        step = { type: 'select', target, value: ev.value ?? '' };
        break;
      case 'extract':
        step = { type: 'extract', target, as: `dato${++extractCount}` };
        break;
    }
    if (step) {
      steps.push(step);
      log(`+ ${step.type}${'target' in step && step.target ? ' ' + step.target.candidates[0] : ''}`);
    }
  });
  await context.addInitScript(INJECT_SCRIPT);

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(opts.url, { waitUntil: 'domcontentloaded' });

  const build = (): Flow => ({
    name: opts.name,
    recordedAt: new Date().toISOString(),
    startUrl: opts.url,
    requiredVars: [...requiredVars],
    steps,
  });

  const closed = new Promise<Flow>((resolve) =>
    context.on('close', () => {
      void browser?.close().catch(() => undefined);
      resolve(build());
    }),
  );
  const stop = async () => {
    if (!done) {
      done = true;
      await context.close().catch(() => undefined);
    }
    return closed;
  };
  return { page, context, stop, closed };
}

export function saveFlow(flow: Flow, file: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(flow, null, 2) + '\n');
}
