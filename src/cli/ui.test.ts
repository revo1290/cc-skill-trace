import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import { confirm, setupColors, stripAnsi, updateHint } from "./ui.js";

describe("stripAnsi", () => {
  it("removes ANSI color escape sequences", () => {
    assert.equal(stripAnsi("\x1B[32mgreen\x1B[0m"), "green");
  });

  it("is a no-op on plain text", () => {
    assert.equal(stripAnsi("plain text"), "plain text");
  });
});

describe("setupColors — NO_COLOR compliance (#179)", () => {
  const savedNoColor = process.env["NO_COLOR"];
  const savedCcNoColor = process.env["CC_NO_COLOR"];
  const savedForceColor = process.env["FORCE_COLOR"];
  const savedLevel = chalk.level;

  afterEach(() => {
    if (savedNoColor != null) process.env["NO_COLOR"] = savedNoColor; else delete process.env["NO_COLOR"];
    if (savedCcNoColor != null) process.env["CC_NO_COLOR"] = savedCcNoColor; else delete process.env["CC_NO_COLOR"];
    if (savedForceColor != null) process.env["FORCE_COLOR"] = savedForceColor; else delete process.env["FORCE_COLOR"];
    chalk.level = savedLevel;
  });

  it("disables chalk output when NO_COLOR is set", () => {
    delete process.env["FORCE_COLOR"];
    process.env["NO_COLOR"] = "1";
    chalk.level = 3;
    setupColors();
    assert.equal(chalk.level, 0);
  });

  it("disables chalk output when CC_NO_COLOR is set", () => {
    delete process.env["FORCE_COLOR"];
    delete process.env["NO_COLOR"];
    process.env["CC_NO_COLOR"] = "1";
    chalk.level = 3;
    setupColors();
    assert.equal(chalk.level, 0);
  });

  it("FORCE_COLOR takes precedence and leaves chalk untouched", () => {
    process.env["FORCE_COLOR"] = "1";
    process.env["NO_COLOR"] = "1";
    chalk.level = 2;
    setupColors();
    assert.equal(chalk.level, 2);
  });
});

describe("confirm (#68)", () => {
  it("returns true immediately when force is set, without touching stdin", async () => {
    assert.equal(await confirm("Proceed?", true), true);
  });

  it("returns false in non-interactive (non-TTY) contexts without hanging", async () => {
    // process.stdin under `node --test` is not a TTY, so this must resolve
    // immediately rather than waiting on readline input.
    const result = await confirm("Proceed?", false);
    assert.equal(result, false);
  });
});

describe("updateHint (#81)", () => {
  it("mentions both the current and latest version", () => {
    const hint = updateHint("2.0.0", "1.9.0");
    const plain = stripAnsi(hint);
    assert.ok(plain.includes("1.9.0"));
    assert.ok(plain.includes("2.0.0"));
    assert.ok(plain.includes("npm install -g cc-skill-trace"));
  });
});
