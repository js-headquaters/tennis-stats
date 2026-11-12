/** The app's release version, injected at build time; null when the build did not provide one. */
export const APP_VERSION: string | null = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : null;
