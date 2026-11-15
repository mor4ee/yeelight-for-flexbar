import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const isWatching = Boolean(process.env.ROLLUP_WATCH);
const pluginDirectory = 'com.mor4ee.yeelight.plugin';

/** @type {import('rollup').RollupOptions} */
const config = {
  input: '.v1-build/v1/plugin.js',
  output: {
    file: `${pluginDirectory}/backend/plugin.cjs`,
    format: 'cjs',
    sourcemap: isWatching,
    sourcemapPathTransform(relativeSourcePath, sourcemapPath) {
      return url.pathToFileURL(
        path.resolve(path.dirname(sourcemapPath), relativeSourcePath)
      ).href;
    }
  },
  plugins: [
    json(),
    {
      name: 'watch-flexdesigner-v1-files',
      buildStart() {
        this.addWatchFile(`${pluginDirectory}/manifest.json`);
        this.addWatchFile('src/v1/plugin.ts');
        this.addWatchFile('src/v1/catalog-runtime.ts');
        for (const file of readdirSync(`${pluginDirectory}/ui`)) {
          if (file.endsWith('.vue')) {
            this.addWatchFile(`${pluginDirectory}/ui/${file}`);
          }
        }
      }
    },
    nodeResolve({
      browser: false,
      exportConditions: ['node'],
      preferBuiltins: true
    }),
    commonjs(),
    !isWatching && terser()
  ],
  external: (id) => id.endsWith('.node')
};

export default config;
