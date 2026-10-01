import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface Employee {
  code: string;
  name: string;
  email: string;
}

/** La API no pudo responder (red, timeout, 401/403/5xx...). No significa que el empleado no exista. */
export class EmployeeApiError extends Error {}

/** Normaliza un código para comparar: sin espacios y sin ceros a la izquierda. */
export const normalizeCode = (code: unknown): string =>
  String(code ?? '').trim().replace(/^0+(?=\d)/, '');

const dig = (obj: unknown, path: string): unknown =>
  path
    ? path.split('.').reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), obj)
    : obj;

/** Consulta de empleados de una ejecución: guarda en memoria lo ya consultado para no repetir llamadas. */
export class EmployeeLookup {
  private readonly cache = new Map<string, Employee | null>();

  constructor(private readonly fetchOne: (code: string) => Promise<Employee | null>) {}

  async find(code: string): Promise<Employee | null> {
    const key = normalizeCode(code);
    if (!this.cache.has(key)) this.cache.set(key, await this.fetchOne(code));
    return this.cache.get(key)!;
  }
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);
  private readonly urlTemplate: string;
  private readonly notFoundStatuses: number[];

  constructor(private readonly config: ConfigService) {
    this.urlTemplate = config.getOrThrow<string>('EMPLOYEES_API_URL');
    if (!this.urlTemplate.includes('{code}')) {
      throw new Error('EMPLOYEES_API_URL debe incluir el marcador {code}, p. ej. https://api.ejemplo.com/empleados/{code}');
    }
    this.notFoundStatuses = config
      .get<string>('EMPLOYEES_API_NOT_FOUND_STATUS', '404')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean);
  }

  lookup(): EmployeeLookup {
    return new EmployeeLookup((code) => this.fetchByCode(code));
  }

  /** Una llamada a la API por código de empleado. Devuelve null si no existe. */
  private async fetchByCode(code: string): Promise<Employee | null> {
    const sendCode = this.config.get('EMPLOYEES_API_STRIP_ZEROS', 'false') === 'true' ? normalizeCode(code) : code;
    const url = this.urlTemplate.replace(/{code}/g, encodeURIComponent(sendCode));
    const token = this.config.get<string>('EMPLOYEES_API_TOKEN');
    const authHeader = this.config.get<string>('EMPLOYEES_API_AUTH_HEADER', 'Authorization');
    const authScheme = this.config.get<string>('EMPLOYEES_API_AUTH_SCHEME', 'Bearer');
    const responsePath = this.config.get<string>('EMPLOYEES_API_RESPONSE_PATH', '');
    const fCode = this.config.get<string>('EMPLOYEES_FIELD_CODE', 'codigo');
    const fName = this.config.get<string>('EMPLOYEES_FIELD_NAME', 'nombre');
    const fEmail = this.config.get<string>('EMPLOYEES_FIELD_EMAIL', 'correo');

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', ...(token ? { [authHeader]: authScheme ? `${authScheme} ${token}` : token } : {}) },
        signal: AbortSignal.timeout(Number(this.config.get('EMPLOYEES_API_TIMEOUT_MS', 30000))),
      });
    } catch (e) {
      throw new EmployeeApiError(`No se pudo consultar la API de empleados: ${(e as Error).message}`);
    }
    if (this.notFoundStatuses.includes(res.status)) return null;
    if (!res.ok) throw new EmployeeApiError(`API de empleados respondió ${res.status} para el código ${code}`);

    let body: unknown;
    try {
      body = dig(await res.json(), responsePath);
    } catch {
      throw new EmployeeApiError('La API de empleados no devolvió JSON válido');
    }

    // La respuesta puede ser un objeto o un arreglo (p. ej. un filtro por query string)
    const wanted = normalizeCode(code);
    const candidates = Array.isArray(body) ? body : body ? [body] : [];
    for (const item of candidates) {
      const itemCode = normalizeCode(dig(item, fCode));
      // Nunca se acepta un empleado cuyo código no coincide: evita mandar un recibo a otra persona
      if (itemCode && itemCode !== wanted) continue;
      return {
        code: wanted,
        name: String(dig(item, fName) ?? '').trim(),
        email: String(dig(item, fEmail) ?? '').trim(),
      };
    }
    this.logger.debug(`Sin coincidencia para el código ${code}`);
    return null;
  }
}
