import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.local-secrets/` is gitignored operator scratch space. Wrangler dry-run
    // bundles and one-off staging audit scripts live there and are deliberately
    // outside the TypeScript project, so repository lint must not discover them.
    // `docs/` is the GitHub Pages poster (HTML/CSS plus a browser click-through
    // script). It is not in the TypeScript project. Type-checked lint must not
    // discover those files.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.local-secrets/**', 'docs/**'],
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
      'src/main.ts',
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
