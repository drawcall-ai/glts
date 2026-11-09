import { LoadingManager } from "three";
import { expect, it } from "vitest";
import { ViewCompletion } from "../src/index.js";

it("counts a view complete after two frames in a row start or end no item while none is open", () => {
  const manager = new LoadingManager();
  const completion = new ViewCompletion(manager);
  manager.itemStart("a");
  expect(completion.frame()).toBe(false);
  expect(completion.frame()).toBe(false);
  manager.itemEnd("a");
  expect(completion.frame()).toBe(false);
  expect(completion.frame()).toBe(false);
  expect(completion.frame()).toBe(true);
  // A view that changed needs two frames of its own.
  completion.restart();
  expect(completion.frame()).toBe(false);
  expect(completion.frame()).toBe(true);
  // An item that starts and ends within a frame still counts as a change.
  manager.itemStart("b");
  manager.itemEnd("b");
  expect(completion.frame()).toBe(false);
});

it("throws a failed item at the next frame, even across a restart, and once", () => {
  const manager = new LoadingManager();
  const completion = new ViewCompletion(manager);
  manager.itemStart("missing.bin");
  manager.itemError("missing.bin");
  manager.itemEnd("missing.bin");
  completion.restart();
  expect(() => completion.frame()).toThrow("- missing.bin");
  expect(completion.frame()).toBe(false);
  expect(completion.frame()).toBe(true);
});

it("fails an item that ends without starting after construction, which still reaches the manager", () => {
  const manager = new LoadingManager();
  let loaded = false;
  manager.onLoad = () => { loaded = true; };
  manager.itemStart("early.bin");
  const completion = new ViewCompletion(manager);
  manager.itemEnd("early.bin");
  expect(loaded).toBe(true);
  expect(() => completion.throwFailures()).toThrow("- early.bin (ended without starting");
  expect(completion.frame()).toBe(false);
});

it("settles once counted frames find the view complete, restarting the count", async () => {
  const manager = new LoadingManager();
  const completion = new ViewCompletion(manager);
  let settled = false;
  manager.itemStart("a");
  const first = completion.settled().then(() => { settled = true; });
  expect(completion.waiting).toBe(true);
  manager.itemEnd("a");
  completion.frame();
  completion.frame();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(completion.frame()).toBe(true);
  await first;
  expect(completion.waiting).toBe(false);
});

it("rejects the settled that wait with the failures, and throws those found with none waiting", async () => {
  const manager = new LoadingManager();
  const completion = new ViewCompletion(manager);
  manager.itemError("missing.bin");
  const waits = [completion.settled(), completion.settled()];
  expect(completion.frame()).toBe(false);
  await expect(waits[0]).rejects.toThrow("- missing.bin");
  await expect(waits[1]).rejects.toThrow("- missing.bin");
  manager.itemError("late.bin");
  expect(() => completion.frame()).toThrow("- late.bin");
  // A failure found by none waits for the next that asks.
  manager.itemError("later.bin");
  const next = completion.settled();
  completion.frame();
  await expect(next).rejects.toThrow("- later.bin");
});

it("gives the manager its own item methods back once disposed", () => {
  const manager = new LoadingManager();
  const { itemStart, itemEnd, itemError } = manager;
  new ViewCompletion(manager).dispose();
  expect(manager).toMatchObject({ itemStart, itemEnd, itemError });
});
