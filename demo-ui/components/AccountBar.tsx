"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SignOutButton } from "./SignOutButton";

interface Me {
  user: { email: string; name: string | null } | null;
  account: { displayName: string | null } | null;
}

/** Who is signed in, with links to settings (or back to chat) and sign out. */
export function AccountBar({ link }: { link: { href: string; label: string } }) {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    void fetch("/api/accounts/me", { cache: "no-store" })
      .then((response) => response.json() as Promise<Me>)
      .then(setMe)
      .catch(() => setMe(null));
    // Settings can rename the profile; pick that up without a reload.
    const onRename = (event: Event) => {
      const displayName = (event as CustomEvent<string>).detail;
      setMe((previous) => (previous?.account ? { ...previous, account: { ...previous.account, displayName } } : previous));
    };
    window.addEventListener("cipher:profile-renamed", onRename);
    return () => window.removeEventListener("cipher:profile-renamed", onRename);
  }, []);

  const user = me?.user;
  const name = me?.account?.displayName || user?.name || user?.email?.split("@")[0];

  return (
    <div className="account-bar">
      <div className="account-who">
        {user ? (
          <>
            <span className="account-hello">Hello, {name}</span>
            <span className="muted small">{user.email}</span>
          </>
        ) : (
          <span className="muted small">&nbsp;</span>
        )}
      </div>
      <div className="account-links small">
        <Link href={link.href}>{link.label}</Link>
        <span className="muted" aria-hidden>
          ·
        </span>
        <SignOutButton />
      </div>
    </div>
  );
}
