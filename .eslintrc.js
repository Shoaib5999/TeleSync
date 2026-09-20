module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // `void somePromise()` is how this codebase marks a deliberately
    // unawaited promise in event handlers and effects. Without it those calls
    // are indistinguishable from an accidentally floating promise.
    'no-void': ['error', { allowAsStatement: true }],

    // react-native-paper's List.Item / Card APIs take `left` and `right` as
    // render props; passing an inline function is the documented usage.
    'react/no-unstable-nested-components': ['warn', { allowAsProps: true }],

    // Allows `const {secret, ...rest} = obj` to drop a field by omission,
    // which is how config persistence keeps api_hash out of SQLite.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { ignoreRestSiblings: true },
    ],
  },
};
