import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface Employee {
  code: string;
  name: string;
  email: string;
}

/** Normaliza un código para comparar: sin espacios y sin ceros a la izquierda. */
export const normalizeCode = (code: unknown): string =>
  String(code ?? '').trim().replace(/^0+(?=\d)/, '');

const dig = (obj: unknown, path: string): unknown =>
  path
    ? path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), obj)
    : obj;

export class EmployeeDirectory {
  constructor(private readonly byCode: Map<string, Employee>) {}
  get size() {
    return this.byCode.size;
  }
  find(code: string): Employee | undefined {
    return this.byCode.get(normalizeCode(code));
  }
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(private readonly config: ConfigService) {}

  /** Descarga la colección completa de empleados desde la API. */
  async load(): Promise<EmployeeDirectory> {
    const url = this.config.getOrThrow<string>('EMPLOYEES_API_URL');
    const token = this.config.get<string>('EMPLOYEES_API_TOKEN');
    const authHeader = this.config.get<string>('EMPLOYEES_API_AUTH_HEADER', 'Authorization');
    const authScheme = this.config.get<string>('EMPLOYEES_API_AUTH_SCHEME', 'Bearer');
    const arrayPath = this.config.get<string>('EMPLOYEES_API_ARRAY_PATH', '');
    const fCode = this.config.get<string>('EMPLOYEES_FIELD_CODE', 'codigo');
    const fName = this.config.get<string>('EMPLOYEES_FIELD_NAME', 'nombre');
    const fEmail = this.config.get<string>('EMPLOYEES_FIELD_EMAIL', 'correo');

    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(token ? { [authHeader]: authScheme ? `${authScheme} ${token}` : token } : {}) },
      signal: AbortSignal.timeout(Number(this.config.get('EMPLOYEES_API_TIMEOUT_MS', 30000))),
    });
    if (!res.ok) throw new Error(`API de empleados respondió ${res.status}`);

    const items = dig(await res.json(), arrayPath);
    if (!Array.isArray(items)) {
      throw new Error('La respuesta de la API de empleados no contiene un arreglo (revisa EMPLOYEES_API_ARRAY_PATH)');
    }

    const byCode = new Map<string, Employee>();
    for (const item of items) {
      const code = normalizeCode(dig(item, fCode));
      if (!code) continue;
      byCode.set(code, {
        code,
        name: String(dig(item, fName) ?? '').trim(),
        email: String(dig(item, fEmail) ?? '').trim(),
      });
    }
    this.logger.log(`Empleados cargados: ${byCode.size}`);
    return new EmployeeDirectory(byCode);
  }
}
