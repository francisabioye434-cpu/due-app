import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMinor, parseMajorToMinor, outstandingBalance } from "../src/domain/money.ts";

test("money parse and format", () => {
  assert.equal(parseMajorToMinor("500000"), 50000000n);
  assert.equal(parseMajorToMinor("10.5"), 1050n);
  assert.equal(formatMinor(30000000n), "₦300,000.00");
  assert.equal(outstandingBalance(500n, [200n, 100n]), 200n);
});
