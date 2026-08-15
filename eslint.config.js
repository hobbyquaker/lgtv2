'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
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
