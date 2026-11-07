/** Deployment settings for the shared-shape catalogue. */

/** Static catalogue site (index.json, packages/*.temen, thumbs/*.png). Trailing slash required. */
const DEFAULT_CATALOG_URL = 'https://belteshazzar.github.io/TemenCAD-catalog/';
// Override for development with localStorage.setItem('temencad.catalogUrl', 'http://localhost:4174/').
export const CATALOG_URL = (() => { try { return globalThis.localStorage?.getItem('temencad.catalogUrl') || DEFAULT_CATALOG_URL; } catch { return DEFAULT_CATALOG_URL; } })();

/** Where the catalogue's source lives, for the "open a pull request" fallback and links. */
export const CATALOG_REPO_URL = 'https://github.com/belteshazzar/TemenCAD-catalog';

/**
 * Publish endpoint (the Cloudflare Worker in the catalogue repo's publish-worker/ folder) that turns a
 * submitted package into a pull request. Empty means "not deployed": the Share dialog then downloads the
 * package and explains how to open the pull request by hand.
 */
export const PUBLISH_URL = '';
