import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { BrowserContext, chromium, Page } from 'playwright';

export interface SessionStatus {
  browserOpen: boolean;
  loggedIn: boolean;
  lastLoginAt: string | null;
}

/**
 * Mantiene UNA sesion persistente al portal BAC. A diferencia del RPA
 * (que limpiaba cookies en cada corrida), reutiliza el perfil del navegador
 * para no aparecer como "dispositivo nuevo" en cada login.
 * Las operaciones se serializan: nunca hay dos acciones simultaneas en la cuenta.
 */
@Injectable()
export class BankSessionService implements OnModuleDestroy {
  private readonly log = new Logger(BankSessionService.name);
  private context?: BrowserContext;
  private lastLoginAt: Date | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  /** Ejecuta `fn` en exclusiva (cola de un solo hilo). */
  run<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => fn(await this.getPage()));
    this.queue = next.catch(() => undefined);
    return next;
  }

  ensureLoggedIn() {
    return this.run(async (page) => {
      if (await this.isLoggedIn(page)) return { loggedIn: true, reused: true };
      await this.login(page);
      return { loggedIn: true, reused: false };
    });
  }

  async status(): Promise<SessionStatus> {
    if (!this.context) return { browserOpen: false, loggedIn: false, lastLoginAt: null };
    const loggedIn = await this.run((page) => this.isLoggedIn(page)).catch(() => false);
    return { browserOpen: true, loggedIn, lastLoginAt: this.lastLoginAt?.toISOString() ?? null };
  }

  async close() {
    await this.queue;
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    return { closed: true };
  }

  onModuleDestroy() {
    return this.close();
  }

  // ---------------------------------------------------------------- internos

  private cfg(key: string, fallback = ''): string {
    return this.config.get<string>(key) ?? fallback;
  }

  private async getPage(): Promise<Page> {
    if (!this.context) {
      const dir = resolve(this.cfg('SESSION_DIR', '.session'));
      mkdirSync(dir, { recursive: true });
      const channel = this.cfg('BROWSER_CHANNEL', 'chrome') || undefined;
      this.context = await chromium.launchPersistentContext(dir, {
        channel,
        headless: this.cfg('HEADLESS', 'false') === 'true',
        viewport: { width: 1366, height: 768 },
        locale: 'es-HN',
        timezoneId: 'America/Tegucigalpa',
      });
      this.context.on('close', () => (this.context = undefined));
    }
    return this.context.pages()[0] ?? this.context.newPage();
  }

  private async isLoggedIn(page: Page): Promise<boolean> {
    const sel = this.cfg('BAC_LOGGED_IN_SELECTOR');
    if (sel) return page.locator(sel).first().isVisible().catch(() => false);
    // Sin selector de "logueado": consideramos sesion activa si no hay campo de password visible.
    if (page.url() === 'about:blank') return false;
    return !(await page.locator(this.cfg('BAC_PASS_SELECTOR', '#pass')).first().isVisible().catch(() => false));
  }

  private async login(page: Page) {
    const user = this.cfg('BAC_USER');
    const pass = this.cfg('BAC_PASSWORD');
    if (!user || !pass) throw new ServiceUnavailableException('BAC_USER/BAC_PASSWORD no configurados');
    const delay = Number(this.cfg('TYPE_DELAY_MS', '70'));

    try {
      this.log.log('Iniciando login');
      await page.goto(this.cfg('BAC_LOGIN_URL'), { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Si el perfil persistente ya trae sesion valida, no hay nada que hacer.
      if (await this.isLoggedIn(page)) {
        this.lastLoginAt = new Date();
        return;
      }

      const userField = page.locator(this.cfg('BAC_USER_SELECTOR', 'input[type="text"]:visible')).first();
      await userField.waitFor({ state: 'visible', timeout: 30_000 });
      await userField.click();
      await userField.pressSequentially(user, { delay });

      const passField = page.locator(this.cfg('BAC_PASS_SELECTOR', '#pass')).first();
      await passField.click();
      await passField.pressSequentially(pass, { delay });

      const submitSel = this.cfg('BAC_SUBMIT_SELECTOR');
      const submit = submitSel
        ? page.locator(submitSel).first()
        : page.getByRole('button', { name: /ingresar/i }).first();
      await submit.click();

      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
      if (!(await this.isLoggedIn(page))) throw new Error('El login no se confirmo (credenciales, 2FA o bloqueo)');

      this.lastLoginAt = new Date();
      this.log.log('Login OK');
    } catch (err) {
      const shot = await this.screenshot(page);
      this.log.error(`Login fallido: ${(err as Error).message} (captura: ${shot ?? 'n/a'})`);
      throw new ServiceUnavailableException('Login al portal fallido');
    }
  }

  private async screenshot(page: Page): Promise<string | null> {
    try {
      const dir = resolve(this.cfg('ARTIFACTS_DIR', 'artifacts'));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `login-fail-${Date.now()}.png`);
      await page.screenshot({ path, fullPage: true });
      return path;
    } catch {
      return null;
    }
  }
}
