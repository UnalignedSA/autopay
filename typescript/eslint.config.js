import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist', 'node_modules'] },
	eslint.configs.recommended,
	tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: { parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js'] } } },
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
		}
	},
	{
		// node:test's test() returns a promise that the runner awaits itself.
		files: ['test/**'],
		rules: { '@typescript-eslint/no-floating-promises': 'off' }
	}
);
