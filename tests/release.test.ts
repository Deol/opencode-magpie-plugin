import { describe, expect, it } from 'vitest';
import { assertPublishedArtifact, tarballIntegrity } from '../scripts/release-metadata.mjs';

const expected = {
  name: 'opencode-magpie-plugin',
  version: '0.1.3',
  integrity: tarballIntegrity(Buffer.from('artifact')),
};
const published = {
  name: expected.name,
  version: expected.version,
  dist: { integrity: expected.integrity },
};

describe('release verification', () => {
  it('accepts an exact artifact when npm omits gitHead', () => {
    expect(() => assertPublishedArtifact(published, expected)).not.toThrow();
  });

  it('rejects different content even when version and gitHead look right', () => {
    expect(() =>
      assertPublishedArtifact(
        {
          ...published,
          gitHead: 'same-commit',
          dist: { integrity: tarballIntegrity(Buffer.from('other')) },
        },
        expected,
      ),
    ).toThrow('integrity');
  });

  it('rejects a missing integrity rather than silently weakening verification', () => {
    expect(() => assertPublishedArtifact({ ...published, dist: {} }, expected)).toThrow(
      'integrity',
    );
  });

  it('rejects a different version or package', () => {
    expect(() => assertPublishedArtifact({ ...published, version: '0.1.2' }, expected)).toThrow(
      'Expected',
    );
    expect(() => assertPublishedArtifact({ ...published, name: 'other' }, expected)).toThrow(
      'Expected',
    );
  });

  it('rejects runtime dependencies, including optional ones', () => {
    expect(() =>
      assertPublishedArtifact({ ...published, dependencies: { unexpected: '1.0.0' } }, expected),
    ).toThrow('runtime dependencies');
    expect(() =>
      assertPublishedArtifact(
        { ...published, optionalDependencies: { unexpected: '1.0.0' } },
        expected,
      ),
    ).toThrow('runtime dependencies');
  });
});
