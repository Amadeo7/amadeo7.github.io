/** Patrón por defecto; se cambia con RECEIPT_FILENAME_REGEX. */
export const DEFAULT_RECEIPT_FILENAME_REGEX = '^Recibo de pago (\\d+)\\.pdf$';

/** Compila el patrón (insensible a mayúsculas) y exige que tenga un grupo de captura: el código de empleado. */
export function compileReceiptRegex(source: string): RegExp {
  let re: RegExp;
  try {
    re = new RegExp(source, 'i');
  } catch {
    throw new Error(`RECEIPT_FILENAME_REGEX no es una expresión regular válida: ${source}`);
  }
  if (new RegExp(`${source}|`).exec('')!.length < 2) {
    throw new Error('RECEIPT_FILENAME_REGEX debe tener un grupo de captura con el código de empleado');
  }
  return re;
}

/** "Recibo de pago 00123.pdf" -> "00123". Devuelve null si el nombre no cumple el patrón. */
export function parseReceiptFilename(fileName: string, re: RegExp): string | null {
  return re.exec(fileName)?.[1] ?? null;
}
