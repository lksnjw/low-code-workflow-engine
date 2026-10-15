import { expect, test } from "vitest";
import { checkedFirestoreState } from "../src/storage/firestore-records.js";
import { initialState } from "../src/repository/store.js";
import { assembleFirestoreState, splitFirestoreState } from "../src/storage/firestore-record-layout.js";

test("pre-credential normalized Firestore snapshots add only an empty unprivileged credential map", () => {
  const before = initialState(); delete (before as Partial<typeof before>).userMcpCredentials;
  const records = splitFirestoreState(before), decoded = assembleFirestoreState(records);
  expect(decoded).not.toHaveProperty("userMcpCredentials");
  const restored = checkedFirestoreState(Buffer.from(JSON.stringify(decoded)));
  expect(restored).toEqual({ ...before, userMcpCredentials: {} });
  expect(assembleFirestoreState(splitFirestoreState(restored))).toEqual(restored);
  expect(before).not.toHaveProperty("userMcpCredentials");
});
test.each([null, [], false, "invalid"])("present malformed credential maps remain rejected: %j", value => {
  const before = { ...initialState(), userMcpCredentials: value };
  expect(() => checkedFirestoreState(Buffer.from(JSON.stringify(before)))).toThrow(/Invalid stored userMcpCredentials/);
});
test("adding the empty map cannot conceal unrelated role repair or permission grants", () => {
  const before = initialState(); delete (before as Partial<typeof before>).userMcpCredentials;
  delete before.roles.role_admin;
  expect(() => checkedFirestoreState(Buffer.from(JSON.stringify(before)))).toThrow(/explicit schema repair/);
});
