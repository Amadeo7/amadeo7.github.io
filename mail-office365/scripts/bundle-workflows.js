// Empaqueta el workflow de Temporal en tiempo de build, para que el worker arranque sin webpack en runtime.
// También sirve de verificación: falla si el workflow importa algo no permitido en el sandbox determinista.
const { bundleWorkflowCode } = require('@temporalio/worker');
const { writeFileSync } = require('fs');
const path = require('path');

(async () => {
  const { code } = await bundleWorkflowCode({ workflowsPath: path.resolve(__dirname, '../dist/temporal/workflows/index.js') });
  writeFileSync(path.resolve(__dirname, '../dist/workflow-bundle.js'), code);
  console.log(`workflow-bundle.js generado (${(code.length / 1024).toFixed(0)} KB)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
