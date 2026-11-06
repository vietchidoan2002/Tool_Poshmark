// Cross-platform: no shell-specific environment-variable syntax required.
process.env.VITE_PREVIEW_ONLY = 'true';
const { build } = await import('vite');
await build(process.env.PREVIEW_OUT_DIR ? { build: { outDir: process.env.PREVIEW_OUT_DIR } } : {});
