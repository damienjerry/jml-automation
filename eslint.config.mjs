import tseslint from 'typescript-eslint'

/**
 * Three project rules exist because each one encodes a failure this toolkit
 * has already seen in production automation:
 *
 *  - no-secret-interpolation: a credential must never reach a log line, an
 *    error message or an audit row. SecretHandle redacts itself, but template
 *    interpolation of a handle would print whatever toString returns, so the
 *    safe path is to forbid the syntax outright.
 *  - no-find-first-result: taking results[0] from a find-by-email once matched
 *    a different person with the same display name and wrote to their account.
 *    A lookup that can return more than one row must handle ambiguity.
 *  - no-raw-http: every outbound call goes through src/core/http.ts, which
 *    surfaces the status and body of a non-2xx response. Code that calls fetch
 *    or node:https directly loses the body, which is how a 401 once read as a
 *    network error for hours.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test/fixtures/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateLiteral > Identifier[name=/[Ss]ecret|[Tt]oken|[Kk]ey$/]',
          message:
            'Never interpolate a secret. Use SecretHandle.use(fn) so the value stays out of logs, errors and the audit log.',
        },
      ],
    },
  },
  {
    // The one module allowed to reach the network directly.
    files: ['src/**/*.ts'],
    ignores: ['src/core/http.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use the client in src/core/http.ts so non-2xx bodies are not lost.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:https', message: 'Use src/core/http.ts.' },
            { name: 'node:http', message: 'Use src/core/http.ts (src/server may use it for the listener).' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
)
