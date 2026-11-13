// Obsidian's recommended rules: the same checks the community directory runs on each
// release, plus typescript-eslint's type-checked rules.
import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
	globalIgnores(['node_modules', 'main.js', 'esbuild.config.mjs', 'version-bump.mjs', 'spike', 'v2-wip']),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: { projectService: { allowDefaultProject: ['eslint.config.mjs', 'vitest.config.js'] } },
		},
	},
	{
		// The tests' mocks are loosely typed on purpose (the directory doesn't scan tests).
		files: ['tests/**'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
		},
	},
]);
