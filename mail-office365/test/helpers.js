require('reflect-metadata');
const { ConfigService } = require('@nestjs/config');

/** Aplica variables de entorno y devuelve un ConfigService nuevo. Un valor undefined borra la variable. */
function config(vars = {}) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  return new ConfigService();
}

const pdf = (s = '') => Buffer.from(`%PDF-1.4\n${s}`);

module.exports = { config, pdf };
