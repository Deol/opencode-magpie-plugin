import { createHash } from 'node:crypto';

export const tarballIntegrity = (bytes) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export const assertPublishedArtifact = (published, expected) => {
  if (published.name !== expected.name || published.version !== expected.version) {
    throw new Error(
      `Expected ${expected.name}@${expected.version}, got ${published.name}@${published.version}`,
    );
  }
  if (published.dist?.integrity !== expected.integrity) {
    throw new Error('Published tarball integrity differs from the artifact built for this tag');
  }
  if (
    Object.keys(published.dependencies ?? {}).length ||
    Object.keys(published.optionalDependencies ?? {}).length
  ) {
    throw new Error('Published package unexpectedly has runtime dependencies');
  }
};
