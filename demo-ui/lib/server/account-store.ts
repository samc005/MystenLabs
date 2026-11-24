// Per-account app data that is not on the chain: contacts, payment notes, payment requests and
// payment plans. One JSON file per kind, inside the account's own directory, so one account can
// never read or write another's. Writes are serialized and atomic.
//
// v2 moves this into a database (the same one the memory/RAG feature will use). Keep the shapes
// simple and append-friendly so that migration is a straight copy.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { accountsDir } from "./accounts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Contact {
  name: string;
  address: string;
  createdAt: string;
}

export interface PaymentNote {
  digest: string;
  note: string;
  createdAt: string;
}

export interface PaymentRequest {
  id: string;
  amountMist: string;
  /** Who it is for, if the user said (a contact name or address). Display only. */
  from: string | null;
  note: string | null;
  /** The address that gets paid: the account's owner wallet. */
  receiver: string;
  createdAt: string;
  status: "open" | "paid" | "cancelled";
  paidDigest?: string;
}

export interface PlanPayment {
  intentId: string;
  dueAt: string;
  expiresAt: string;
  status: "scheduled" | "paid" | "failed" | "expired" | "cancelled";
  digest?: string;
  error?: string;
}

export interface PaymentPlan {
  id: string;
  recipient: string;
  amountMist: string;
  every: "day" | "week";
  count: number;
  note: string | null;
  /** The owner's transaction that created and locked the approvals on-chain. */
  createdDigest: string;
  createdAt: string;
  payments: PlanPayment[];
}

interface Kinds {
  contacts: Contact[];
  notes: PaymentNote[];
  requests: PaymentRequest[];
  plans: PaymentPlan[];
}

function dirFor(accountId: string): string {
  if (!UUID.test(accountId)) throw new Error("Invalid account id.");
  return path.join(accountsDir(), "data", accountId);
}

async function load<K extends keyof Kinds>(accountId: string, kind: K): Promise<Kinds[K]> {
  try {
    return JSON.parse(await readFile(path.join(dirFor(accountId), `${kind}.json`), "utf8")) as Kinds[K];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as unknown as Kinds[K];
    throw error;
  }
}

async function save<K extends keyof Kinds>(accountId: string, kind: K, value: Kinds[K]): Promise<void> {
  const dir = dirFor(accountId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `${kind}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, path.join(dir, `${kind}.json`));
}

const queues = new Map<string, Promise<unknown>>();

/** Read-modify-write one kind for one account, one change at a time. */
export function mutate<K extends keyof Kinds, T>(
  accountId: string,
  kind: K,
  change: (items: Kinds[K]) => T | Promise<T>,
): Promise<T> {
  const key = `${accountId}:${kind}`;
  const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
    const items = await load(accountId, kind);
    const result = await change(items);
    await save(accountId, kind, items);
    return result;
  });
  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function read<K extends keyof Kinds>(accountId: string, kind: K): Promise<Kinds[K]> {
  return load(accountId, kind);
}

// ---- Contacts ----

export const CONTACT_NAME = /^[A-Za-z][A-Za-z0-9 ._'-]{0,29}$/;
const ADDRESS = /^0x[0-9a-f]{64}$/;

export async function saveContact(accountId: string, name: string, address: string): Promise<Contact> {
  const trimmed = name.trim();
  const normalized = address.toLowerCase();
  if (!CONTACT_NAME.test(trimmed)) throw new Error("Contact names are letters, numbers and spaces, up to 30 characters.");
  if (!ADDRESS.test(normalized)) throw new Error("That is not a full Sui address.");
  return mutate(accountId, "contacts", (contacts) => {
    const existing = contacts.find((contact) => contact.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      existing.address = normalized;
      return existing;
    }
    if (contacts.length >= 200) throw new Error("You can save up to 200 contacts.");
    const contact = { name: trimmed, address: normalized, createdAt: new Date().toISOString() };
    contacts.push(contact);
    return contact;
  });
}

export async function deleteContact(accountId: string, name: string): Promise<void> {
  await mutate(accountId, "contacts", (contacts) => {
    const index = contacts.findIndex((contact) => contact.name.toLowerCase() === name.trim().toLowerCase());
    if (index >= 0) contacts.splice(index, 1);
  });
}

/** Name -> address for this account: server-configured contacts first, the account's own override them. */
export async function contactsFor(accountId: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  let configured: Record<string, string> = {};
  try {
    configured = JSON.parse(env.WALLET_CONTACTS_JSON ?? "{}") as Record<string, string>;
  } catch {
    configured = {};
  }
  const merged: Record<string, string> = {};
  for (const [name, address] of Object.entries(configured)) {
    if (typeof address === "string" && /^0x[0-9a-fA-F]{64}$/.test(address)) merged[name] = address.toLowerCase();
  }
  for (const contact of await read(accountId, "contacts")) merged[contact.name] = contact.address;
  return merged;
}

/** Address -> name, for showing friendly labels. */
export async function labelsFor(accountId: string): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(await contactsFor(accountId)).map(([name, address]) => [address, name]));
}

// ---- Notes ----

export const NOTE = /^[A-Za-z0-9][A-Za-z0-9 ,.'!?&()$#@:/+-]{0,79}$/;

export async function saveNote(accountId: string, digest: string, note: string): Promise<void> {
  if (!NOTE.test(note)) return;
  await mutate(accountId, "notes", (notes) => {
    if (!notes.some((entry) => entry.digest === digest)) notes.push({ digest, note, createdAt: new Date().toISOString() });
  });
}

export async function notesFor(accountId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await read(accountId, "notes")).map((entry) => [entry.digest, entry.note]));
}
