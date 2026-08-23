import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, resolveCrew, phaseOwner, serviceRoles } from "../config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "blanche-cfg-"));

test("feat crew resolves with the documented shape", () => {
  const c = resolveCrew(DEFAULT_CONFIG, "feat");
  assert.equal(c.roster.length, 6);
  assert.equal(c.phases.length, 8);
  assert.equal(c.specs, true);
  assert.equal(phaseOwner(c, "PLAN_REVIEW"), "leader");
  assert.equal(phaseOwner(c, "NOPE"), undefined);
  assert.deepEqual(serviceRoles(c), ["researcher", "advisor"]);
});

test("unknown workflow throws naming the known workflows", () => {
  assert.throws(() => resolveCrew(DEFAULT_CONFIG, "bad"), /quick/);
});

test("absent config file falls back to DEFAULT_CONFIG and writes it on first use", () => {
  const path = join(tmp(), "pi-blanche.json");
  assert.equal(existsSync(path), false);
  const cfg = loadConfig(path);
  assert.equal(existsSync(path), true, "first use must persist the default config");
  assert.deepEqual(Object.keys(cfg.workflows).sort(), Object.keys(DEFAULT_CONFIG.workflows).sort());
  assert.equal(Object.keys(cfg.workflows).length, 7);
  // the written file must itself be loadable
  assert.deepEqual(Object.keys(loadConfig(path).workflows).length, 7);
});

test("workflow agent override beats the top-level profile for that role only", () => {
  const path = join(tmp(), "pi-blanche.json");
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.workflows.feat.agents = { worker: { model: "override/model", thinking: "max" } };
  writeFileSync(path, JSON.stringify(cfg, null, 2));

  const crew = resolveCrew(loadConfig(path), "feat");
  assert.equal(crew.agents.worker.model, "override/model");
  assert.equal(crew.agents.worker.thinking, "max");
  assert.equal(crew.agents.qa.model, DEFAULT_CONFIG.agents.qa.model, "other roles untouched");
});

test("configRevision hashes the raw file text, not a re-serialisation", () => {
  const path = join(tmp(), "pi-blanche.json");
  // deliberately odd whitespace: a re-serialised hash would not see this
  const raw = JSON.stringify(DEFAULT_CONFIG, null, 4) + "\n\n";
  writeFileSync(path, raw);

  const crew = resolveCrew(loadConfig(path), "feat");
  const expected = createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
  assert.equal(crew.configRevision, expected);
});

test("resolveCrew keeps only roster roles in agents", () => {
  const crew = resolveCrew(DEFAULT_CONFIG, "quick");
  assert.deepEqual(Object.keys(crew.agents).sort(), ["qa", "worker"]);
});

test("validation rejects a bad phase owner naming the JSON path", () => {
  const path = join(tmp(), "pi-blanche.json");
  const cfg = structuredClone(DEFAULT_CONFIG) as any;
  cfg.workflows.feat.phases[3].owner = "nobody";
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  assert.throws(() => loadConfig(path), /workflows\.feat\.phases\[3\]\.owner/);
});
