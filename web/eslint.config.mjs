import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

/**
 * AegisDID lint configuration.
 *
 * `react-hooks/exhaustive-deps` is kept as a WARNING rather than off: the camera and liveness
 * code is full of refs and rAF loops where a stale closure is a real correctness bug, so the
 * signal is worth reading even when a given dep list is intentionally narrow.
 */
const config = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'public/**',
      '.cache/**',
      'next-env.d.ts',
    ],
  },
  {
    rules: {
      // Unused code in a security-sensitive audit surface should be removed, not tolerated.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      /**
       * WARN, not ERROR, and deliberately so. Every remaining `any` sits on an untyped
       * third-party boundary: snarkjs, circomlibjs and face-api.js ship no type definitions
       * (hence types/modules.d.ts), and `window.ethereum` is injected by the wallet. Forcing
       * these to `unknown` would only relocate the casts, not add safety. They stay visible as
       * warnings so a new one in first-party logic is still noticed.
       */
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];

export default config;
