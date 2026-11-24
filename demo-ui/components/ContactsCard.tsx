"use client";

import { useCallback, useEffect, useState } from "react";
import { shortAddress } from "@/lib/display";
import { OwnerActionCard } from "./OwnerActionCard";

interface Contact {
  name: string;
  address: string;
}

/** Your saved contacts: add, remove, and make one a trusted recipient (signed by your wallet). */
export function ContactsCard({ trusted, onChanged }: { trusted: string[]; onChanged: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [trusting, setTrusting] = useState<Contact | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/contacts", { cache: "no-store" });
    const body = (await response.json()) as { contacts?: Contact[] };
    setContacts(body.contacts ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    setError(null);
    const response = await fetch("/api/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, address }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) return setError(body.error ?? "Could not save the contact.");
    setName("");
    setAddress("");
    await load();
  }

  async function remove(contact: Contact) {
    await fetch(`/api/contacts?name=${encodeURIComponent(contact.name)}`, { method: "DELETE" });
    await load();
  }

  return (
    <article className="card">
      <div className="card-head">
        <h2>Contacts</h2>
      </div>
      <p className="muted">
        Pay people by name, like &ldquo;send 0.05 to Sam&rdquo;. You can also save one in chat: &ldquo;save 0x… as Sam&rdquo;.
      </p>
      {contacts.length === 0 && <p className="muted small">No contacts yet.</p>}
      <ul className="contact-list">
        {contacts.map((contact) => {
          const isTrusted = trusted.includes(contact.address);
          return (
            <li key={contact.name}>
              <span>
                <strong>{contact.name}</strong>{" "}
                <span className="mono muted small" title={contact.address}>
                  {shortAddress(contact.address)}
                </span>{" "}
                {isTrusted && <span className="status-pill approved">trusted</span>}
              </span>
              <span className="actions">
                {!isTrusted && (
                  <button className="link" onClick={() => setTrusting(contact)}>
                    Trust
                  </button>
                )}
                <button className="link" onClick={() => void remove(contact)}>
                  Remove
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {trusting && (
        <OwnerActionCard
          key={trusting.address}
          action={{ kind: "trust", address: trusting.address, name: trusting.name }}
          onDone={() => {
            setTrusting(null);
            onChanged();
          }}
        />
      )}
      <div className="actions">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={30} />
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x… full address"
          spellCheck={false}
        />
        <button className="secondary" onClick={() => void add()} disabled={!name.trim() || !address.trim()}>
          Save contact
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </article>
  );
}
