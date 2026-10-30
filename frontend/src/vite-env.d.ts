/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module 'js-beautify/js/src/javascript/index.js' {
  const beautify: (source: string, options?: Record<string, unknown>) => string;
  export default beautify;
}
