// =====================================================================
// ESLint flat config. TypeScript + React + Hooks + Refresh.
// =====================================================================

import js from '@eslint/js';
import globals from 'globals';
import tsparser from '@typescript-eslint/parser';
import tsplugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: 2022, sourceType: 'module' },
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    plugins: {
      '@typescript-eslint': tsplugin,
      'react-hooks':        reactHooks,
      'react-refresh':      reactRefresh,
    },
    rules: {
      ...tsplugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    ignores: ['dist', 'dist-ssr', 'build', 'node_modules', '.vite', 'coverage'],
  },
];
