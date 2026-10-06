import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@canlang/testkit' || specifier.startsWith('@canlang/testkit/')) {
      throw new Error('independence audit: CLI must not load @canlang/testkit');
    }
    return nextResolve(specifier, context);
  },
});
