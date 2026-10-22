const js = require('@eslint/js')
const tseslint = require('typescript-eslint')
const vue = require('eslint-plugin-vue')
const accessibility = require('eslint-plugin-vuejs-accessibility')
const comments = require('@eslint-community/eslint-plugin-eslint-comments')
const templateComments = require('./scripts/eslint-template-comments.cjs')

module.exports = tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'server/data/**'] },
  {
    files: ['{client,server,shared}/**/*.{ts,vue}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: ['./client/tsconfig.json', './server/tsconfig.eslint.json', './shared/tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
        extraFileExtensions: ['.vue']
      }
    },
    plugins: { 'eslint-comments': comments },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Start typed checks with promise safety; keep existing API/test typing intact.
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': ['error', {
        // node:test owns registration promises and reports callback failures itself.
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it', 'test'] }]
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'eslint-comments/require-description': 'error',
      'eslint-comments/no-unlimited-disable': 'error',
      'eslint-comments/no-use': ['error', { allow: ['eslint-disable-next-line'] }]
    }
  },
  ...vue.configs['flat/recommended'],
  ...accessibility.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    plugins: { 'template-comments': templateComments },
    rules: {
      'template-comments/specific-disable-with-reason': 'error',
      // Either a wrapping label or an explicit for/id pair associates a control.
      'vuejs-accessibility/label-has-for': ['error', { required: { some: ['nesting', 'id'] } }]
    }
  }
)
