import baseConfig from '../../eslint.config.mjs'

export default [
  ...baseConfig,
  {
    files: ['packages/ocean-ifft/**/*.{js,jsx,ts,tsx}'],
    ignores: ['packages/ocean-ifft/public/**', 'packages/ocean-ifft/resources/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/consistent-generic-constructors': 'off',
      '@typescript-eslint/prefer-readonly': 'off',
      '@typescript-eslint/prefer-return-this-type': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-for-in-array': 'off',
      'guard-for-in': 'off',
      'no-prototype-builtins': 'off',
      'logical-assignment-operators': 'off'
    }
  }
]
