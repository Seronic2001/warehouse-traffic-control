import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/, so the Pages workflow builds
// with BASE_PATH set; local dev and preview stay at the root.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
});
