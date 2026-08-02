import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillFrontmatter } from "./skill-md.js";

describe("parseSkillFrontmatter", () => {
  it("parses name and a single-line description", () => {
    const content = `---\nname: pdf\ndescription: Extract text from PDF files\n---\n\nBody text.`;
    assert.deepEqual(parseSkillFrontmatter(content), {
      name: "pdf",
      description: "Extract text from PDF files",
    });
  });

  it("strips quotes around name and description", () => {
    const content = `---\nname: "pdf"\ndescription: 'Extract text'\n---\n`;
    assert.deepEqual(parseSkillFrontmatter(content), { name: "pdf", description: "Extract text" });
  });

  it("returns null when there is no frontmatter block", () => {
    assert.equal(parseSkillFrontmatter("# Just a heading\n\nNo frontmatter here."), null);
  });

  it("returns null when name is missing", () => {
    const content = `---\ndescription: no name here\n---\n`;
    assert.equal(parseSkillFrontmatter(content), null);
  });

  it("returns a skill with an undefined description when description is absent", () => {
    const content = `---\nname: commit\n---\n`;
    assert.deepEqual(parseSkillFrontmatter(content), { name: "commit", description: undefined });
  });

  it("joins a YAML block-scalar (>) description across multiple indented lines", () => {
    const content = `---\nname: pdf\ndescription: >\n  Extract text from PDF files\n  and summarize them.\nversion: 1\n---\n`;
    const result = parseSkillFrontmatter(content);
    assert.equal(result?.name, "pdf");
    assert.equal(result?.description, "Extract text from PDF files and summarize them.");
  });

  it("joins a YAML block-scalar (|) description and stops at the next key", () => {
    const content = `---\nname: pdf\ndescription: |\n  Line one.\n  Line two.\nother: value\n---\n`;
    const result = parseSkillFrontmatter(content);
    assert.equal(result?.description, "Line one. Line two.");
  });

  it("handles CRLF line endings in the frontmatter delimiter", () => {
    const content = "---\r\nname: pdf\r\ndescription: works on windows\r\n---\r\n";
    assert.deepEqual(parseSkillFrontmatter(content), { name: "pdf", description: "works on windows" });
  });
});
