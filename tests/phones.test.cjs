const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone } = require("../server/phones.cjs");
test("phone numbers normalize to E.164 across local, international and spaced input", () => {
  for (const value of [
    "0901234567",
    "0901 234 567",
    "0901.234.567",
    "+84 901 234 567",
  ])
    assert.equal(normalizePhone(value), "+84901234567");
  assert.equal(normalizePhone("+1 (415) 555-2671"), "+14155552671");
});
test("junk, extensions, partial and non-string phone values are rejected", () => {
  for (const value of [
    "",
    null,
    901234567,
    "abc0901234567",
    "0901234567 ext 3",
    "12345",
    "0000000000",
    "+999123456789",
    "<script>0901234567</script>",
    "9".repeat(60),
  ])
    assert.throws(
      () => normalizePhone(value),
      (error) => error.status === 400,
    );
});
