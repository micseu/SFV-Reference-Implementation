import js from '@eslint/js';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';

export default [
  {ignores:['node_modules/**','out/**','coverage/**','scenarios/validation/generated/**']},
  js.configs.recommended,
  {
    files:['**/*.{js,mjs}'],
    languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{...globals.node}},
    plugins:{'@stylistic':stylistic},
    rules:{
      // No tab characters anywhere.
      '@stylistic/no-tabs':'error',
      'no-unused-vars':['error',{argsIgnorePattern:'^_',ignoreRestSiblings:true}]
    }
  },
  // src/ is shared by Node simulations and the browser; web/public runs in the browser.
  {files:['src/**/*.js','web/public/**/*.js'],languageOptions:{globals:{...globals.browser,...globals.node}}},
  {
    // ABR rules must stay pure and deterministic.
    files:['src/rules/**/*.js'],
    rules:{
      'no-restricted-globals':['error',
        {name:'fetch',message:'ABR rules must be pure: no network access.'},
        {name:'window',message:'ABR rules must not depend on the browser environment.'},
        {name:'document',message:'ABR rules must not depend on the browser environment.'}],
      'no-restricted-properties':['error',
        {object:'Date',property:'now',message:'ABR rules must use the injected clock, not Date.now().'},
        {object:'performance',property:'now',message:'ABR rules must use the injected clock, not performance.now().'}]
    }
  }
];
