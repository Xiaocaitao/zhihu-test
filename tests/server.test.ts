import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createPowuServer } from "../src/server.ts";

test("health endpoint returns a successful JSON response", async (t) => {
  const server = createPowuServer();
  t.after(() => server.close());

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
