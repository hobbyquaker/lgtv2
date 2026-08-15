import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {...globals.node},
        },
        rules: {
            'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none'}],
        },
    },
    {
        ignores: ['node_modules/', 'lgtv2-patches/'],
    },
];
