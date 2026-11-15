// FlexCLI 1.0.7 mixes old and new JSON import syntax. Normalize only the
// legacy import in its pack command, in memory. Do not modify node_modules.
import { registerHooks } from 'node:module';
const pack = import.meta.resolve('@eniac/flexcli/src/commands/pack.js');
registerHooks({load(url, context, next) {
  const module = next(url, context);
  if (url !== pack) return module;
  return {...module, source: Buffer.from(module.source).toString().replace(
    "from '../assets/manifest_schema.json' assert", "from '../assets/manifest_schema.json' with")};
}});
await import('@eniac/flexcli/src/index.js');
