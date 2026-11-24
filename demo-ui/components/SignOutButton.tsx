"use client";

import { useState } from "react";

/**
 * Ends the Google session and returns to the sign-in screen. The tab's zkLogin session key is
 * dropped (signing in again makes a new one). A legacy browser-stored owner key stays: deleting it
 * would lock that owner out of their own vault.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("logout failed");
      try {
        window.sessionStorage.removeItem("cipher-zklogin-ephemeral");
      } catch {
        // Nothing stored.
      }
      // Only leave once the session cookie is cleared. Otherwise the home page would send the user straight back.
      window.location.assign("/");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <button className="link" onClick={() => void signOut()} disabled={busy}>
      {busy ? "Signing out…" : failed ? "Could not sign out. Try again" : "Sign out"}
    </button>
  );
}
