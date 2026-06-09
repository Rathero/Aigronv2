// eslint.config.js — lint de todo el repo (backend + motor compartido + frontend).
// Vive en la raíz para poder cubrir server/ y web/ a la vez (ESLint ignora
// ficheros fuera del directorio del config). Las dependencias (eslint) están
// en server/package.json: ejecútalo con `cd server && npm run lint`.
// Objetivo: cazar errores reales (variables sin definir, typos, await olvidados)
// sin pelearse con el estilo existente del proyecto.
const js = require("./server/node_modules/@eslint/js");
const globals = require("./server/node_modules/globals");

const baseRules = {
  // El código usa argumentos no usados en callbacks de Express (req, next).
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
  // Patrón habitual aquí: `catch (e) {}` para flujos opcionales.
  "no-empty": ["error", { allowEmptyCatch: true }],
};

module.exports = [
  {
    ...js.configs.recommended,
    files: ["server/src/**/*.js", "server/scripts/**/*.js", "server/test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...baseRules },
  },
  {
    // Código que corre en el navegador. engine.js es el motor compartido
    // (también lo carga el servidor vía require), de ahí los globals de node.
    ...js.configs.recommended,
    files: ["web/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.node,
        ENGINE: "readonly", // expuesto por web/engine.js (motor compartido)
        google: "readonly", // Google Identity Services (script externo)
      },
    },
    rules: { ...js.configs.recommended.rules, ...baseRules },
  },
];
