/** Un elemento de la pagina descrito con varios selectores, del mas estable al menos estable. */
export interface Target {
  candidates: string[];
  /** Si el elemento vive dentro de un iframe. */
  frame?: { name?: string; url?: string };
  /** Descripcion legible (solo informativa). */
  label?: string;
}

export type Step =
  | { type: 'goto'; url: string }
  | { type: 'click'; target: Target; optional?: boolean }
  | { type: 'fill'; target: Target; value: string; secret?: boolean; optional?: boolean }
  | { type: 'press'; target?: Target; key: string }
  | { type: 'select'; target: Target; value: string }
  | { type: 'waitFor'; target?: Target; state?: 'visible' | 'hidden' | 'attached'; urlPattern?: string; ms?: number }
  /** Lee texto (o un atributo) y lo devuelve en `outputs[as]`. `all: true` devuelve un arreglo. */
  | { type: 'extract'; target: Target; as: string; attr?: string; all?: boolean }
  | { type: 'screenshot'; name?: string };

export interface Flow {
  name: string;
  recordedAt: string;
  startUrl: string;
  /** Variables que el flujo necesita al ejecutarse (ej. contrasenas). Nunca se guardan sus valores. */
  requiredVars: string[];
  steps: Step[];
}

/** Evento crudo que envia la pagina al grabador. */
export interface RawEvent {
  type: 'click' | 'fill' | 'press' | 'select' | 'extract';
  candidates: string[];
  value?: string;
  key?: string;
  secret?: boolean;
  field?: string;
  label?: string;
}
