// Do not inherit the static-preview flag when moving to a full web service.
process.env.VITE_PREVIEW_ONLY = 'false';
const { build } = await import('vite');
await build();
