/// <reference types="node" />
/**
 * `jsonFileStore(path)` — persist local mode to one JSON file (Node, Bun,
 * Deno with node compat). Separate entry point (`@usekeyring/sdk/local/file`)
 * so edge/browser bundles of `@usekeyring/sdk/local` never touch `node:fs`.
 *
 * Reads the file once, serves everything from memory (synchronous — so
 * `canSync()` works), and rewrites it atomically (temp file + rename) after
 * every change. The file is a `KeyringSnapshot`, so `importState()` reads it
 * too. Single process: run one writer per file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyModel, memoryStore, type KeyringSnapshot, type KeyringStore, type RuntimeModel, type StoredSubject } from "./store.js";

export type JsonFileStoreOptions = {
  /** Pretty-print the file (default true — readable and diffable). */
  pretty?: boolean;
};

export function jsonFileStore(path: string, opts: JsonFileStoreOptions = {}): KeyringStore {
  let initial: Partial<KeyringSnapshot> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    if (raw.trim()) {
      try {
        initial = JSON.parse(raw) as Partial<KeyringSnapshot>;
      } catch (err) {
        throw new Error(`jsonFileStore: ${path} is not valid JSON: ${(err as Error).message}`);
      }
    }
  }
  const mem = memoryStore({ model: initial.model, subjects: initial.subjects ?? {} });
  let seq = 0;
  const flush = () => {
    const subjects: Record<string, StoredSubject> = {};
    for (const id of mem.listSubjects() as string[]) subjects[id] = mem.getSubject(id) as StoredSubject;
    const snapshot: KeyringSnapshot = {
      format: "keyring.local",
      version: 1,
      exportedAt: new Date().toISOString(),
      model: (mem.getModel() as RuntimeModel | undefined) ?? emptyModel(),
      subjects,
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${++seq}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, opts.pretty === false ? undefined : 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    getSubject: (id) => mem.getSubject(id),
    setSubject: (id, s) => {
      mem.setSubject(id, s);
      flush();
    },
    deleteSubject: (id) => {
      mem.deleteSubject(id);
      flush();
    },
    listSubjects: () => mem.listSubjects(),
    getModel: () => mem.getModel(),
    setModel: (m) => {
      mem.setModel(m);
      flush();
    },
  };
}
