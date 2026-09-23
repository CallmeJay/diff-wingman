import { makeFixture } from '../tests/fixture.js';

const fixture = await makeFixture(false);
console.log(
  JSON.stringify({ repo: fixture.repo, base: fixture.base, target: fixture.target }, null, 2),
);
