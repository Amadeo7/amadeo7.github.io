import { writeFileSync } from 'fs';
import { join } from 'path';
import { saveFlow, startRecording } from './recorder';
import { FlowError, runFlow } from './player';

type Args = { _: string[]; flags: Record<string, string | boolean>; vars: Record<string, string> };

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--var') {
      const [k, ...rest] = (argv[++i] ?? '').split('=');
      out.vars[k] = rest.join('=');
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const browserOpts = (f: Args['flags']) => ({
  channel: str(f.channel) ?? process.env.BROWSER_CHANNEL,
  executablePath: str(f.executable) ?? process.env.CHROMIUM_PATH,
  profileDir: str(f.profile),
});

const HELP = `rpa-recorder

  record <nombre> --url <url> [--profile dir] [--parametrize] [--channel chrome]
      Abre el navegador y graba lo que haces. Cierra la ventana (o Ctrl+C) para guardar en flows/<nombre>.json
      Alt+Click sobre un elemento = marcarlo como dato a extraer.

  play <flows/archivo.json> [--var NOMBRE=valor ...] [--headless] [--profile dir]
       [--slowmo ms] [--type-delay ms] [--timeout ms] [--out resultado.json]
      Reproduce el flujo con Playwright. Las variables tambien se leen del entorno (process.env).
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parse(rest);

  if (cmd === 'record') {
    const name = args._[0];
    const url = str(args.flags.url);
    if (!name || !url) return console.log(HELP);
    const rec = await startRecording({
      name,
      url,
      parametrize: !!args.flags.parametrize,
      log: (m) => console.log(m),
      ...browserOpts(args.flags),
    });
    console.log('Grabando... veras una etiqueta roja "REC n" arriba a la derecha del navegador (se pone verde en cada accion).');
    console.log('Usa el navegador normalmente. Cierra la ventana (o Ctrl+C aqui) para terminar y guardar.');
    console.log('Alt+Click = marcar un dato a extraer.');
    process.once('SIGINT', () => void rec.stop());
    const flow = await rec.closed;
    const file = join('flows', `${name}.json`);
    saveFlow(flow, file);
    console.log(`\nGuardado ${file} (${flow.steps.length} pasos)`);
    if (flow.requiredVars.length) {
      console.log('Variables requeridas al reproducir:');
      for (const v of flow.requiredVars) console.log(`  ${v}=`);
    }
    return;
  }

  if (cmd === 'play') {
    const file = args._[0];
    if (!file) return console.log(HELP);
    try {
      const res = await runFlow(file, {
        vars: args.vars,
        headless: !!args.flags.headless,
        slowMo: args.flags.slowmo ? Number(args.flags.slowmo) : undefined,
        typeDelayMs: args.flags['type-delay'] ? Number(args.flags['type-delay']) : undefined,
        timeoutMs: args.flags.timeout ? Number(args.flags.timeout) : undefined,
        log: (m) => console.log(m),
        ...browserOpts(args.flags),
      });
      console.log(`\nOK en ${res.durationMs} ms`);
      console.log(JSON.stringify(res.outputs, null, 2));
      const out = str(args.flags.out);
      if (out) writeFileSync(out, JSON.stringify(res.outputs, null, 2));
    } catch (err) {
      console.error((err as Error).message);
      if (err instanceof FlowError && err.screenshot) console.error(`Captura: ${err.screenshot}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log(HELP);
}

main();
