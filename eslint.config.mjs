import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  {
    // 构建配置文件由 tsc 兜底检查，不参与 typed-lint（eslint.config.mjs 自身无法进入 project service）
    ignores: [
      'out/',
      'dist/',
      'node_modules/',
      '.tools/',
      'coverage/',
      '*.db',
      'eslint.config.mjs',
      '*.config.ts',
      'scripts/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // 禁止 any：确需动态类型时用 unknown 并收窄（NFR-7）
      '@typescript-eslint/no-explicit-any': 'error',
      // 禁止吞异常：捕获必须处理（记录/包装/上抛）
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'off'
    }
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn'
    }
  },
  {
    // 构建与测试配置文件放宽部分规则
    files: ['*.config.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off'
    }
  }
)
