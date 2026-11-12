import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.local-secrets/` is gitignored operator scratch space. Wrangler dry-run
    // bundles and one-off staging audit scripts live there and are deliberately
    // outside the TypeScript project, so repository lint must not discover them.
    // `web/` is the React app. It has its own package.json, tsconfig and ESLint
    // config (`cd web && npm run lint`), and root type-checked lint must not
    // discover its files.
    // `infra/` is the CDK app. It has its own package.json and tsconfig
    // (`cd infra && npm run check`), and root type-checked lint must not discover it.
    // `docs/` is the GitHub Pages poster (HTML/CSS plus a browser click-through
    // script). It is not in the TypeScript project. Type-checked lint must not
    // discover those files.
    // `.playwright-mcp/` and `.claude/worktrees/` are git-ignored local agent output.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.local-secrets/**',
      'docs/**',
      '.wrangler/**',
      'web/**',
      'infra/**',
      '.playwright-mcp/**',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            'Read configuration through src/config instead of process.env directly (SUAS-specs ENVIRONMENT.md §3-§5).',
        },
      ],
    },
  },
  {
    // The configuration loader, CLIs, and tests are the authorized readers of the
    // raw environment; everything else must go through the validated config object.
    files: [
      'src/config/**/*.ts',
      'src/provenance/**/*.ts',
      'src/cli/**/*.ts',
      'scripts/**/*.ts',
      'eval/**/*.ts',
      'src/main.ts',
      'src/aws/websocket-lambda.ts',
      'src/aws/job-worker-lambda.ts',
      'src/aws/migrate-lambda.ts',
      'src/aws/smtp-relay-lambda.ts',
      'tests/**/*.ts',
      '*.config.ts',
    ],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
