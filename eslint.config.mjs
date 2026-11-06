// P&N — ESLint flat config.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
      'dist-install/**',
      // `workspaces/` là nơi agent viết mã cho dự án của KHÁCH. Mã đó theo luật
      // của dự án đó, không theo luật của P&N. Không loại trừ ở đây thì agent
      // vừa viết xong một file là `npm run verify` đỏ, vì lý do chẳng liên quan
      // gì tới nền tảng.
      'workspaces/**',
    ],
  },
  {
    // File cấu hình build và script công cụ chạy trên Node, không phải trong
    // trình duyệt — chúng có sẵn process, console, Buffer.
    files: ['**/*.config.{js,mjs,cjs}', 'tools/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
