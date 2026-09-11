import assert from "node:assert/strict";
import test from "node:test";

import { createDoubaoModels } from "../src/agent/pi-route-agent.ts";

test("Doubao runtime uses the Responses API and the configured endpoint model", () => {
  const models = createDoubaoModels("ep-test", "https://ark.example.test/api/v3");
  const model = models.getModel("doubao", "ep-test");

  assert.ok(model);
  assert.equal(model.api, "openai-responses");
  assert.equal(model.baseUrl, "https://ark.example.test/api/v3");
  assert.equal((model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole, false);
});
