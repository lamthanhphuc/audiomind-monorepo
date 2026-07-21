import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'tests/e2e/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Keep hooks plugin enabled but avoid blocking on legacy dependency arrays.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
      // Existing FE codebase uses `any` in places; enforce on new Phase 2 files below.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-unused-expressions': 'off',
      'no-empty': 'off',
      'prefer-const': 'off',
      'no-useless-escape': 'off',
      'no-extra-boolean-cast': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: [
      'src/types/subjectSynthesis.ts',
      'src/types/studyArtifacts.ts',
      'src/services/subjectSynthesis.ts',
      'src/services/studyArtifacts.ts',
      'src/components/study/**/*.{ts,tsx}',
      'src/utils/subjectTabs.ts',
      'src/utils/subjectEvidence.ts',
      'src/utils/flashcardQuizHelpers.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
)
