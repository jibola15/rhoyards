import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// Floating-point parsing is banned where money is handled; use the Decimal helpers in @rhoyards/shared.
const noFloatMoney = {
  'no-restricted-globals': [
    'error',
    { name: 'parseFloat', message: 'Use Decimal helpers from @rhoyards/shared for numeric business values.' },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Number', property: 'parseFloat', message: 'Use Decimal helpers from @rhoyards/shared.' },
  ],
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/api/**/*.ts', 'packages/shared/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: noFloatMoney,
  },
  {
    files: ['apps/backoffice/**/*.{ts,tsx}', 'apps/storefront/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
);
