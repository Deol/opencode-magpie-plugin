import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/model-pricing.ts'],
  format: ['esm'],
  clean: true,
  dts: true,
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
});
